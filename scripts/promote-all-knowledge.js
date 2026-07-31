/**
 * Generate COMPONENT_PROPERTIES from saved dev-knowledge JSON files.
 * Does NOT re-parse d.ts — uses the saved knowledge (which has runtime defaults).
 */
const path = require('path');
const fs = require('fs');
const mod = require(path.resolve(__dirname, '../dist/tools/cocos/utils/component-knowledge'));

const files = mod.listKnowledgeFiles();
const snippets = [];

for (const comp of files) {
    const knowledge = mod.loadKnowledgeFile(comp);
    if (!knowledge) continue;
    snippets.push(mod.generateTsSnippet(comp, knowledge));
    const propCount = Object.keys(knowledge.properties).length;
    const defaultCount = Object.values(knowledge.properties).filter(p => p.default !== undefined).length;
    console.log(`  ${comp.padEnd(35)} ${propCount} props, ${defaultCount} with defaults`);
}

const outputPath = path.resolve(__dirname, '../dev-knowledge/COMPONENT_PROPERTIES_GENERATED.txt');
const header = `const COMPONENT_PROPERTIES: Record<string, any> = {\n`;
const footer = `\n};\n`;
fs.writeFileSync(outputPath, header + snippets.join('\n') + footer, 'utf-8');
console.log(`\nGenerated ${files.length} components → ${outputPath}`);
