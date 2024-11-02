const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
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
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
        
        if (session.payment_status === 'paid') {
            const userId = session.metadata.userId;
            const purchasedCredits = parseInt(session.metadata.credits);
            
            const credits = await readCredits();
            const currentCredits = credits[userId] || 0;
            credits[userId] = currentCredits + purchasedCredits;
            await writeCredits(credits);
            
            res.status(200).json({ success: true, credits: credits[userId] });
        } else {
            res.status(400).json({ error: 'Payment not completed' });
        }
    } catch (error) {
        console.error('Error processing payment success:', error);
        res.status(500).json({ error: error.message });
    }
} 