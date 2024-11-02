const { kv } = require('@vercel/kv');

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { userId } = req.body;
        const credits = await kv.get(`credits:${userId}`) || 5; // Default 5 credits
        res.status(200).json({ credits });
    } catch (error) {
        console.error('Error checking credits:', error);
        res.status(500).json({ error: error.message });
    }
} 