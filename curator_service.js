const { exec } = require('child_process');
const axios = require('axios');

// Your EarnKaro ID: 5017699
const EARNKARO_ID = '5017699';

const GEMINI_PROMPT = `
Act as a Premium Kids Product Curator for KidoKulture.
Rules:
1. MATERIAL: ONLY "Real Wood", "100% Cotton", "Wool", "Silk", or "Organic/Nutritious".
2. REJECT: Anything plastic, polyester, or processed food.
3. AGE GROUPS: Strictly 0-1, 1-3, 3-5, 5-10, 10-14.
4. OUTPUT: JSON format only: {"title":"", "material":"", "age_group":"", "link":""}
`;

/**
 * Scans product data string and uses gemini-cli for curation
 * @param {string} productData - Raw string containing product details to curate
 */
function scanAndCurate(productData) {
    // Escaping double quotes for the shell command
    const escapedData = productData.replace(/"/g, '\\"');
    const cmd = `echo "${escapedData}" | gemini-cli "${GEMINI_PROMPT.replace(/\n/g, ' ')}"`;
    
    exec(cmd, async (error, stdout) => {
        if (error) {
            console.error(`Exec Error: ${error.message}`);
            return;
        }
        
        try {
            // Find JSON in stdout (in case of filler text)
            const jsonMatch = stdout.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error("No JSON found in output");
            
            const curated = JSON.parse(jsonMatch[0]);
            
            // Append your EarnKaro ID to the link
            curated.affiliate_link = `${curated.link}${curated.link.includes('?') ? '&' : '?'}id=${EARNKARO_ID}`;
            
            // Push to your local KidoKulture API
            // Note: In production, use a secure API key for this internal endpoint
            await axios.post('http://localhost:3000/api/bot/curate', curated);
            console.log(`✅ Curated: ${curated.title}`);
        } catch (e) {
            console.log("❌ Product did not meet premium standards or parsing failed. Skipping...");
        }
    });
}

// Example usage (uncomment to test):
// scanAndCurate("Wooden building blocks for toddlers, made of sustainable maple wood. Age 1-3. Link: https://example.com/toy");

module.exports = { scanAndCurate };
