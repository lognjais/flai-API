const Archiver = require('archiver');

const streamHead = (req, res, next, torrent, client) => {
    res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-disposition': `attachment; filename="${torrent.name}.zip"`
    });

    const zip = Archiver('zip', { zlib: { level: 0 } }); // Level 0 saves CPU on Render
    zip.pipe(res);

    zip.on('error', (err) => {
        console.error('[torrents] Zip Error:', err);
        return next(err);
    });

    res.on('close', () => {
        try { client.remove(torrent.infoHash); } catch (err) { }
    });

    // Pipe all torrent files directly into the zip archive
    torrent.files.forEach(file => {
        zip.append(file.createReadStream(), { name: file.name });
    });

    zip.finalize();
};

const handleTorrents = (req, res, next, client, magnetCache) => {
    try {
        const fileName = req.params.file_name;
        const magnetURI = magnetCache.get(fileName);

        if (!magnetURI) {
            return res.redirect('https://jvoltci.github.io/flai/#/error');
        }

        if (client.get(magnetURI)) {
            const torrent = client.get(magnetURI);
            streamHead(req, res, next, torrent, client);
        } else {
            client.add(magnetURI, (torrent) => {
                streamHead(req, res, next, torrent, client);
            }).on('error', (err) => {
                console.error('Cannot Add Torrent', err);
                try { client.remove(magnetURI); } catch (e) { }
                return res.redirect('https://jvoltci.github.io/flai/#/error');
            });
        }
    } catch (err) {
        console.error("[torrents] Error:", err);
        return res.redirect('https://jvoltci.github.io/flai/#/error');
    }
};

module.exports = { handleTorrents };