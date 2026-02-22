const streamHead = (req, res, next, torrent, client, id) => {
    const file = torrent.files[id];
    const stream = file.createReadStream();
    
    stream.pipe(res);

    stream.on("error", (err) => {
        console.error('[torrent] Stream Error:', err);
        return next(err);
    });

    res.on('close', () => {
        stream.destroy();
        // Check if no other streams are using this torrent before removing
        if (torrent.numPeers === 0) {
            try { client.remove(torrent.infoHash); } catch (err) { }
        }
    });
};

const handleTorrent = async (req, res, next, client, db, magnetCache) => {
    try {
        const fileName = req.params.file_name;
        const magnetURI = magnetCache.get(fileName);

        if (!magnetURI) {
            return res.redirect('https://jvoltci.github.io/flai/#/error');
        }

        if (client.get(magnetURI)) {
            const torrent = client.get(magnetURI);
            const id = torrent.files.findIndex(f => f.name === fileName);
            
            if (id === -1) return res.redirect('https://jvoltci.github.io/flai/#/error');
            streamHead(req, res, next, torrent, client, id);
        } else {
            client.add(magnetURI, async (torrent) => {
                const id = torrent.files.findIndex(f => f.name === fileName);
                if (id === -1) return res.redirect('https://jvoltci.github.io/flai/#/error');

                try {
                    const existing = await db.collection('flai').findOne({ url: magnetURI }, { projection: { link: 1 } });
                    if (!existing) {
                        const link = "torrent/" + torrent.name;
                        await db.collection('flai').insertOne({ link, url: magnetURI, date: new Date().toISOString() });
                    }
                } catch (err) {
                    console.error('DB Error:', err);
                }

                streamHead(req, res, next, torrent, client, id);
            }).on('error', (err) => {
                console.error('Cannot Add torrent:', err);
                try { client.remove(magnetURI); } catch (e) { }
                return res.redirect('https://jvoltci.github.io/flai/#/error');
            });
        }
    } catch (e) {
        console.error("[torrent] Z-Error: ", e);
        return res.redirect('https://jvoltci.github.io/flai/#/error');
    }
};

module.exports = { handleTorrent };