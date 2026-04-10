const fs = require('fs');
const path = require('path');

const skillsDir = path.join(__dirname, '..', 'src', 'skills');

// Quick XML entity unescaper
function unescapeXml(safe) {
    if (!safe) return '';
    return safe.replace(/&(lt|gt|amp|apos|quot);/g, (match, entity) => {
        switch (entity) {
            case 'lt': return '<';
            case 'gt': return '>';
            case 'amp': return '&';
            case 'apos': return "'";
            case 'quot': return '"';
        }
        return match;
    });
}

function convertSkills() {
    if (!fs.existsSync(skillsDir)) {
        console.error(`❌ Skills directory not found at: ${skillsDir}`);
        return;
    }

    const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.xml'));
    let count = 0;

    for (const file of files) {
        const filePath = path.join(skillsDir, file);
        const xml = fs.readFileSync(filePath, 'utf8');

        // Extract attributes
        const getAttr = (attrName) => {
            const regex = new RegExp(`\\b${attrName}\\s*=\\s*(["'])(.*?)\\1`, 'is');
            const match = xml.match(regex);
            return match ? unescapeXml(match[2]) : '';
        };

        // Standardize IDs to kebab-case
        let rawId = getAttr('id') || file.replace('.xml', '');
        let id = rawId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
        
        let title = getAttr('title');
        let description = getAttr('description') || 'No description provided.';
        let category = getAttr('category') || 'general';
        let timestamp = getAttr('timestamp') || Date.now().toString();

        // Extract content (Handle CDATA, <content> tags, or raw inner text)
        let content = '';
        const cdataMatch = xml.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
        if (cdataMatch) {
            content = cdataMatch[1].trim();
        } else {
            const contentMatch = xml.match(/<content>\s*([\s\S]*?)\s*<\/content>/);
            if (contentMatch) {
                content = unescapeXml(contentMatch[1].trim());
            } else {
                content = xml.replace(/^<skill[^>]*>/i, '').replace(/<\/skill>\s*$/i, '').trim();
            }
        }

        // Fallback for title if missing
        if (!title) {
            title = content.split('\n')[0].replace(/[#*`]/g, '').trim().substring(0, 40) || id;
        }

        // Build YAML Frontmatter and Markdown Body
        const createdDate = new Date(parseInt(timestamp)).toISOString().split('T')[0];
        
        // Wrap description nicely for YAML
        const yamlDescription = description.replace(/\n/g, ' ').trim();

        const mdContent = `---
name: ${id}
description: >
  ${yamlDescription}
author: Lollms User
version: 1.0.0
category: ${category}
created: ${createdDate}
---

${content}
`;

        // Create new folder structure (Format A)
        const targetDir = path.join(skillsDir, id);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        const mdPath = path.join(targetDir, 'SKILL.md');
        fs.writeFileSync(mdPath, mdContent, 'utf8');
        
        // Delete the old XML file
        fs.unlinkSync(filePath);
        
        console.log(`✅ Converted: ${file} -> ${id}/SKILL.md`);
        count++;
    }
    
    console.log(`\n🎉 Successfully converted ${count} skills to Claude Code format!`);
}

convertSkills();