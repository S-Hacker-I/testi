const admin = require('firebase-admin');

module.exports = async (req, res) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }

    try {
        const token = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);
        res.json({ uid: decodedToken.uid });
    } catch (error) {
        res.status(401).json({ error: 'Invalid token' });
    }
}; 