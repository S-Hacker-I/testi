require('dotenv').config();
const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// Increase limits for JSON and URL-encoded bodies
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

const CREDITS_FILE = path.join(__dirname, 'data', 'credits.json');

// Initialize storage
async function initializeStorage() {
    console.log('Initializing storage...');
    try {
        await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
        try {
            await fs.access(CREDITS_FILE);
            console.log('Credits file exists');
        } catch {
            console.log('Creating new credits file');
            await fs.writeFile(CREDITS_FILE, JSON.stringify({}));
        }
    } catch (error) {
        console.error('Error initializing storage:', error);
        await fs.writeFile(CREDITS_FILE, JSON.stringify({}));
    }
}

// Credit management functions
async function getUserCredits(userId) {
    console.log('Getting credits for user:', userId);
    try {
        const data = JSON.parse(await fs.readFile(CREDITS_FILE, 'utf8'));
        console.log('Current credits data:', data);
        return data[userId] || 5;
    } catch (error) {
        console.error('Error reading credits:', error);
        return 5;
    }
}

async function useCredit(userId) {
    console.log('Using credit for user:', userId);
    try {
        const data = JSON.parse(await fs.readFile(CREDITS_FILE, 'utf8'));
        console.log('Current credits before use:', data);
        if (!data[userId] || data[userId] < 1) {
            throw new Error('Insufficient credits');
        }
        data[userId]--;
        await fs.writeFile(CREDITS_FILE, JSON.stringify(data, null, 2));
        console.log('Credits after use:', data);
        return data[userId];
    } catch (error) {
        console.error('Error using credit:', error);
        throw error;
    }
}

// Image generation function with detailed logging
async function generateImage(data) {
    console.log('Starting image generation with prompt:', data.prompt);
    try {
        console.log('Preparing request to Hugging Face API');
        console.log('API Key present:', !!process.env.HUGGINGFACE_API_KEY);
        
        const requestConfig = {
            method: 'post',
            url: 'https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0',
            headers: {
                'Authorization': `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
                'Content-Type': 'application/json'
            },
            data: { inputs: data.prompt },
            responseType: 'arraybuffer',
            timeout: 60000 // Increased timeout to 60 seconds
        };
        
        console.log('Sending request with config:', {
            url: requestConfig.url,
            method: requestConfig.method,
            headers: { ...requestConfig.headers, 'Authorization': '[REDACTED]' },
            timeout: requestConfig.timeout
        });

        const response = await axios(requestConfig);
        
        console.log('Received response from API');
        console.log('Response status:', response.status);
        console.log('Response headers:', response.headers);

        // Check if response is an error message
        if (response.headers['content-type'].includes('application/json')) {
            const errorText = Buffer.from(response.data).toString('utf8');
            console.error('API returned error:', errorText);
            throw new Error(errorText);
        }

        console.log('Converting image data to base64');
        const base64Image = Buffer.from(response.data).toString('base64');
        console.log('Image data converted successfully');
        
        return `data:image/jpeg;base64,${base64Image}`;
    } catch (error) {
        console.error('Error in generateImage:', error);
        console.error('Error details:', {
            message: error.message,
            code: error.code,
            response: error.response ? {
                status: error.response.status,
                headers: error.response.headers,
                data: error.response.data
            } : 'No response'
        });
        throw new Error(`Failed to generate image: ${error.message}`);
    }
}

// API endpoints with detailed logging
app.post('/api/generate-image', async (req, res) => {
    console.log('Received generate-image request');
    console.log('Request body:', {
        prompt: req.body.prompt,
        userId: req.body.userId
    });

    try {
        const { prompt, userId } = req.body;
        if (!prompt) {
            console.log('Missing prompt in request');
            return res.status(400).json({ error: 'Prompt is required' });
        }

        console.log('Checking credits for user:', userId);
        const remainingCredits = await useCredit(userId);
        console.log('Remaining credits:', remainingCredits);

        console.log('Starting image generation');
        const image = await generateImage({ prompt });
        console.log('Image generation successful');

        console.log('Sending response to client');
        res.json({ image, credits: remainingCredits });
    } catch (error) {
        console.error('Error in generate-image endpoint:', error);
        
        if (error.message !== 'Insufficient credits') {
            try {
                console.log('Refunding credit to user:', req.body.userId);
                await addCredits(req.body.userId, 1);
                console.log('Credit refunded successfully');
            } catch (refundError) {
                console.error('Failed to refund credit:', refundError);
            }
        }

        res.status(500).json({ error: error.message });
    }
});

// Add these new endpoints for Stripe integration
app.post('/api/create-payment-intent', async (req, res) => {
    try {
        const { amount } = req.body;
        const paymentIntent = await stripe.paymentIntents.create({
            amount: amount * 100, // Convert to cents
            currency: 'usd',
            automatic_payment_methods: {
                enabled: true,
            },
        });

        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (error) {
        console.error('Error creating payment intent:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add this function for managing credits
async function addCredits(userId, credits) {
    try {
        const data = JSON.parse(await fs.readFile(CREDITS_FILE, 'utf8'));
        data[userId] = (data[userId] || 0) + credits;
        await fs.writeFile(CREDITS_FILE, JSON.stringify(data, null, 2));
        return data[userId];
    } catch (error) {
        console.error('Error adding credits:', error);
        throw error;
    }
}

app.post('/api/payment-success', async (req, res) => {
    try {
        const { userId, credits } = req.body;
        const newCreditBalance = await addCredits(userId, credits);
        res.json({ credits: newCreditBalance });
    } catch (error) {
        console.error('Error processing payment success:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add these endpoints
app.post('/api/check-credits', async (req, res) => {
    try {
        const { userId } = req.body;
        const credits = await getUserCredits(userId);
        res.json({ credits });
    } catch (error) {
        console.error('Error checking credits:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { packageId, userId } = req.body;
        const package = CREDIT_PACKAGES.find(p => p.id === packageId);
        
        if (!package) {
            return res.status(400).json({ error: 'Invalid package' });
        }

        const successUrl = `${req.protocol}://${req.get('host')}/success?session_id={CHECKOUT_SESSION_ID}`;
        const cancelUrl = `${req.protocol}://${req.get('host')}`;

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: `${package.credits} Credits`,
                        description: package.name
                    },
                    unit_amount: package.price * 100,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: successUrl,
            cancel_url: cancelUrl,
            metadata: {
                userId,
                credits: package.credits.toString()
            }
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Error creating checkout session:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add the CREDIT_PACKAGES constant
const CREDIT_PACKAGES = [
    { id: 'credits_10', credits: 10, price: 5, name: 'Basic Pack' },
    { id: 'credits_25', credits: 25, price: 10, name: 'Popular Pack' },
    { id: 'credits_50', credits: 50, price: 18, name: 'Pro Pack' }
];

// Modify the payment-success endpoint
app.get('/api/payment-success', async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
        
        if (session.payment_status === 'paid') {
            const userId = session.metadata.userId;
            const credits = parseInt(session.metadata.credits);
            const newCreditBalance = await addCredits(userId, credits);
            
            res.json({ 
                success: true, 
                credits: newCreditBalance 
            });
        } else {
            res.status(400).json({ error: 'Payment not completed' });
        }
    } catch (error) {
        console.error('Error processing payment success:', error);
        res.status(500).json({ error: error.message });
    }
});

// Initialize storage on startup
initializeStorage().catch(console.error);

// Start server with error handling
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}).on('error', (error) => {
    console.error('Server failed to start:', error);
});

// Handle server shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

// Add these routes before your API endpoints
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/success', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'success.html'));
}); 