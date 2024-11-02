export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { userId } = req.body;
        // For now, return a default value
        res.status(200).json({ credits: 5 });
    } catch (error) {
        console.error('Error checking credits:', error);
        res.status(500).json({ error: error.message });
    }
} 