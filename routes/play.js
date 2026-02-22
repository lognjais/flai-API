const http = require('http');
const https = require('https');

const handlePlay = async (req, res, db) => {
    try {
        const fetchedLink = req.params.id;
        if (!fetchedLink || fetchedLink.length < 10) {
            return res.redirect('https://flai.ml');
        }

        const data = await db.collection('flai').findOne({ link: fetchedLink }, { projection: { url: 1 } });
        
        if (data && data.url) {
            const targetUrl = data.url;
            const client = targetUrl.startsWith('https') ? https : http;

            client.get(targetUrl, (response) => {
                if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
                    const redirectUrl = response.headers.location;
                    const redirectClient = redirectUrl.startsWith('https') ? https : http;
                    redirectClient.get(redirectUrl, (redirectResp) => {
                        res.writeHead(200, { 'Content-Type': redirectResp.headers['content-type'] || 'application/octet-stream' });
                        redirectResp.pipe(res);
                    }).on('error', () => res.redirect('https://jvoltci.github.io/flai/#/error'));
                } else {
                    res.writeHead(200, { 'Content-Type': response.headers['content-type'] || 'application/octet-stream' });
                    response.pipe(res);
                }
            }).on('error', () => {
                res.redirect('https://jvoltci.github.io/flai/#/error');
            });
        } else {
            return res.redirect('https://flai.ml');
        }
    } catch (err) {
        console.error('[play] Error:', err);
        return res.status(500).send('Internal Error');
    }
};

module.exports = { handlePlay };