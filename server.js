const express = require('express');
const cors = require('cors');
const { MongoClient } = require("mongodb");
const WebTorrent = require('webtorrent');

const download = require('./routes/download');
const links = require('./routes/links');
const play = require('./routes/play');
const metadata = require('./routes/metadata');
const torrentRoute = require('./routes/torrent');
const torrentsRoute = require('./routes/torrents');

// Database config
const connectionUrl = process.env.DATABASE || 'mongodb://localhost:27017';
const dbClient = new MongoClient(connectionUrl);
const databaseName = "flaiDB";
let db;

async function initDB() {
    try {
        await dbClient.connect();
        db = dbClient.db(databaseName);
        console.log('Database Connected successfully to server');
    } catch (err) {
        console.error('Database connection failed:', err);
    }
}
initDB();

const client = new WebTorrent();
const app = express();
const port = process.env.PORT || 5000;

// Cache to replace the buggy global magnetURI variable. 
// Maps file_name -> magnetURI safely across concurrent requests.
const magnetCache = new Map();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    const allowedOrigins = ['https://jvoltci.github.io', 'https://jvoltci.github.io/flai', 'https://flai.ivehement.com'];
    const origin = req.headers.origin;
    if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

app.get('/', (req, res) => { res.send('It is working API v2') });
app.post('/download', (req, res) => { download.handleDownload(req, res, db) });
app.get('/links/:id', (req, res) => { links.handleLinks(req, res, db) });
app.get('/play/:id', (req, res) => { play.handlePlay(req, res, db) });
app.post('/metadata', (req, res) => { metadata.handleMetadata(req, res, client, magnetCache) });
app.get('/torrent/:file_name', (req, res, next) => { torrentRoute.handleTorrent(req, res, next, client, db, magnetCache) });
app.get('/torrents/:file_name', (req, res, next) => { torrentsRoute.handleTorrents(req, res, next, client, magnetCache) });

process.on('uncaughtException', (err) => {
    console.error('Error: Process', err);
});

app.listen(port, () => {
    console.log(`App is running on port ${port}`);
});

module.exports = app;