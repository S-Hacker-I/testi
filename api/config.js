const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        if (!process.env.STRIPE_PUBLISHABLE_KEY) {
            throw new Error('Stripe publishable key is not configured');
        }

        return res.status(200).json({
            publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
            environment: process.env.NODE_ENV
        });
    } catch (error) {
        console.error('Config endpoint error:', error);
        return res.status(500).json({
            error: {
                message: error.message || 'Internal server error',
                code: 'CONFIG_ERROR'
            }
        });
    }
}; 