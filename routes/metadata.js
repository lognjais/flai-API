const handleMetadata = (req, res, client, magnetCache) => {
    try {
        const password = req.body.password;
        if (req.method === "POST" && password === process.env.PASS) {
            const magnetURI = req.body.url;

            if (client.get(magnetURI)) {
                const torrent = client.get(magnetURI);
                const files = torrent.files.map(data => {
                    magnetCache.set(data.name, magnetURI);
                    return data.name;
                });
                return res.status(200).json(files);
            } else {
                client.add(magnetURI, torrent => {
                    const files = torrent.files.map(data => {
                        // Link the filename to the magnet URI for subsequent GET requests
                        magnetCache.set(data.name, magnetURI);
                        return data.name;
                    });
                    return res.status(200).json(files);
                }).on('error', (err) => {
                    console.error('[metadata] Client Add Error:', err);
                    try { client.remove(magnetURI); } catch (e) { }
                    return res.redirect('https://jvoltci.github.io/flai/#/error');
                });
            }
        } else {
            return res.redirect('https://jvoltci.github.io/flai/#/error');
        }
    } catch (err) {
        console.error('[metadata] Error:', err);
        return res.redirect('https://jvoltci.github.io/flai/#/error');
    }
};

module.exports = { handleMetadata };