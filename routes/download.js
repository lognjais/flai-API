const { makeid } = require('./lib/makeid');

const handleDownload = async (req, res, db) => {
    try {
        const password = req.body.user?.password;
        const url = req.body.user?.url;

        if (password === process.env.PASS && url) {
            const data = await db.collection('flai').findOne({ url }, { projection: { link: 1 } });
            let link = '';

            if (data) {
                link = data.link;
            } else {
                link = makeid(10);
                const now = new Date().toISOString();
                await db.collection('flai').insertOne({ link, url, date: now });
            }
            return res.redirect('/links/' + link);
        } else {
            return res.redirect('https://jvoltci.github.io/flai/#/error');
        }
    } catch (err) {
        console.error('[download] Error:', err);
        return res.redirect('https://jvoltci.github.io/flai/#/error');
    }
};

module.exports = { handleDownload };