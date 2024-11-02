const axios = require('axios');
const { kv } = require('@vercel/kv');

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { prompt, userId } = req.body;
        
        if (!prompt || !userId) {
            return res.status(400).json({ error: 'Missing prompt or userId' });
        }

        // Check credits
        const credits = await kv.get(`credits:${userId}`) || 0;
        console.log(`User ${userId} has ${credits} credits`);
        
        if (credits < 1) {
            return res.status(402).json({ error: 'Insufficient credits' });
        }

        // Call Hugging Face API
        const response = await axios({
            method: 'post',
            url: 'https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0',
            headers: {
                'Authorization': `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
                'Content-Type': 'application/json'
            },
            data: { 
                inputs: prompt,
                options: {
                    wait_for_model: true
                }
            },
            responseType: 'arraybuffer',
            timeout: 120000 // 2 minutes timeout
        });

        // Deduct credit before generating image
        const newCredits = credits - 1;
        await kv.set(`credits:${userId}`, newCredits);

        const base64Image = Buffer.from(response.data).toString('base64');
        res.status(200).json({ 
            image: `data:image/jpeg;base64,${base64Image}`,
            credits: newCredits
        });
    } catch (error) {
        console.error('Error generating image:', error);
        res.status(500).json({ error: error.message });
    }
} 