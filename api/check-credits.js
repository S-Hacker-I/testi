const fs = require('fs').promises;
const path = require('path');

const CREDITS_FILE = path.join(process.cwd(), 'data', 'credits.json');

async function readCredits() {
    try {
        const data = await fs.readFile(CREDITS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return {};
    }
}

async function writeCredits(credits) {
    await fs.writeFile(CREDITS_FILE, JSON.stringify(credits, null, 2));
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { userId } = req.body;
        const credits = await readCredits();
        const userCredits = credits[userId] || 5; // Default 5 credits
        res.status(200).json({ credits: userCredits });
    } catch (error) {
        console.error('Error checking credits:', error);
        res.status(500).json({ error: error.message });
    }
} 