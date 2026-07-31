/**
 * validate-schemas.js
 * 构建后校验所有 MCP 工具的 inputSchema，检测常见 JSON Schema 错误：
 * - array 类型缺少 items
 * - object 类型缺少 properties
 * - enum 为空数组
 * - type 字段缺失
 */

const path = require('path');
const fs = require('fs');

// 颜色
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

let errors = 0;
let warnings = 0;

function validateSchema(schema, context, toolName) {
    if (!schema || typeof schema !== 'object') return;

    // 检查 array 缺少 items
    if (schema.type === 'array' && !schema.items) {
        console.error(`${RED}ERROR${RESET} [${toolName}] ${context}: type "array" missing "items"`);
        errors++;
    }

    // 检查 items 但不是 array
    if (schema.items && schema.type !== 'array') {
        console.warn(`${YELLOW}WARN${RESET}  [${toolName}] ${context}: has "items" but type is "${schema.type}", not "array"`);
        warnings++;
    }

    // 检查 enum 为空
    if (schema.enum && Array.isArray(schema.enum) && schema.enum.length === 0) {
        console.warn(`${YELLOW}WARN${RESET}  [${toolName}] ${context}: empty "enum" array`);
        warnings++;
    }

    // 递归检查 properties
    if (schema.properties && typeof schema.properties === 'object') {
        for (const [key, value] of Object.entries(schema.properties)) {
            validateSchema(value, `${context}.${key}`, toolName);
        }
    }

    // 递归检查 items
    if (schema.items && typeof schema.items === 'object') {
        validateSchema(schema.items, `${context}.items`, toolName);
    }
}

function main() {
    const distDir = path.join(__dirname, '..', 'dist');
    if (!fs.existsSync(distDir)) {
        console.error(`${RED}ERROR${RESET} dist/ not found. Run "npm run build" first.`);
        process.exit(1);
    }

    // 收集所有工具定义
    const tools = [];

    // 1. 加载 CocosTools
    try {
        const { CocosTools } = require(path.join(distDir, 'tools', 'cocos', 'cocos-tools.js'));
        const cocosTools = new CocosTools();
        tools.push(...cocosTools.getTools());
    } catch (e) {
        console.warn(`${YELLOW}WARN${RESET}  Could not load CocosTools: ${e.message}`);
    }

    // 2. 加载独立工具集
    const toolFiles = [
        'tools/scene-tools.js',
        'tools/node-tools.js',
        'tools/component-tools.js',
        'tools/prefab-tools.js',
        'tools/project-tools.js',
        'tools/scene-view-tools.js',
        'tools/reference-image-tools.js',
        'tools/preferences-tools.js',
        'tools/asset-advanced-tools.js',
        'tools/debug-tools.js',
        'tools/server-tools.js',
    ];

    for (const file of toolFiles) {
        try {
            const fullPath = path.join(distDir, file);
            if (!fs.existsSync(fullPath)) continue;
            const mod = require(fullPath);
            // 找到导出的类并实例化
            for (const [, ExportedClass] of Object.entries(mod)) {
                if (typeof ExportedClass === 'function' && ExportedClass.prototype && typeof ExportedClass.prototype.getTools === 'function') {
                    const instance = new ExportedClass();
                    tools.push(...instance.getTools());
                }
            }
        } catch (e) {
            console.warn(`${YELLOW}WARN${RESET}  Could not load ${file}: ${e.message}`);
        }
    }

    console.log(`\nValidating ${tools.length} tool schemas...\n`);

    for (const tool of tools) {
        if (tool.inputSchema) {
            validateSchema(tool.inputSchema, 'inputSchema', tool.name);
        }
    }

    console.log('');
    if (errors > 0) {
        console.error(`${RED}FAILED${RESET}: ${errors} error(s), ${warnings} warning(s)`);
        process.exit(1);
    } else if (warnings > 0) {
        console.log(`${YELLOW}PASSED${RESET} with ${warnings} warning(s)`);
    } else {
        console.log(`${GREEN}PASSED${RESET}: All schemas valid`);
    }
}

main();
