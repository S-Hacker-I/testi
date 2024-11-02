const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { kv } = require('@vercel/kv');

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
        
        if (session.payment_status === 'paid') {
            const userId = session.metadata.userId;
            const credits = parseInt(session.metadata.credits);
            
            // Use Vercel KV instead of file system
            const currentCredits = await kv.get(`credits:${userId}`) || 0;
            const newCredits = currentCredits + credits;
            await kv.set(`credits:${userId}`, newCredits);
            
            res.json({ 
                success: true, 
                credits: newCredits 
            });
        } else {
            res.status(400).json({ error: 'Payment not completed' });
        }
    } catch (error) {
        console.error('Error processing payment success:', error);
        res.status(500).json({ error: error.message });
    }
} 