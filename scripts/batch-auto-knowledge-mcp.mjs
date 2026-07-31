#!/usr/bin/env node
/**
 * Batch auto_knowledge via MCP HTTP — gets runtime defaults from editor
 * Requires: editor running with MCP on port 3000
 */

import http from 'http';

const MCP_URL = 'http://127.0.0.1:3000/mcp';
const ALL = [
    'cc.Label','cc.Sprite','cc.Button','cc.Widget','cc.Layout',
    'cc.UITransform','cc.RichText','cc.ScrollView','cc.Toggle',
    'cc.ToggleContainer','cc.ProgressBar','cc.Slider','cc.PageView',
    'cc.Mask','cc.Graphics','cc.UIOpacity','cc.SafeArea',
    'cc.BlockInputEvents','cc.LabelOutline','cc.LabelShadow',
    'cc.PageViewIndicator','cc.EditBox',
    'cc.AudioSource','cc.VideoPlayer','cc.WebView',
    'cc.ParticleSystem2D',
    'cc.Camera','cc.Canvas','cc.Animation','cc.SkeletalAnimation',
    'cc.MeshRenderer','cc.SkinnedMeshRenderer',
    'cc.DirectionalLight','cc.PointLight','cc.SpotLight','cc.SphereLight',
    'cc.RigidBody2D','cc.BoxCollider2D','cc.CircleCollider2D','cc.PolygonCollider2D',
    'cc.RigidBody','cc.BoxCollider','cc.SphereCollider','cc.CapsuleCollider','cc.MeshCollider',
    'cc.MotionStreak','cc.Billboard','cc.Line',
    'cc.TiledMap','cc.TiledLayer',
    'cc.HingeJoint2D','cc.DistanceJoint2D','cc.SpringJoint2D',
    'cc.FixedJoint2D','cc.WheelJoint2D','cc.SliderJoint2D',
    'cc.RelativeJoint2D','cc.MouseJoint2D',
    'cc.HingeConstraint','cc.FixedConstraint','cc.PointToPointConstraint',
    'cc.Terrain','cc.LODGroup','cc.ReflectionProbe',
    'sp.Skeleton','dragonBones.ArmatureDisplay',
];

function callMcp(toolName, args) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
            params: { name: toolName, arguments: args }
        });
        const req = http.request(MCP_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 30000,
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try {
                    const data = JSON.parse(Buffer.concat(chunks).toString());
                    const content = data.result?.content || [];
                    const text = content.find(c => c.type === 'text')?.text;
                    resolve(text ? JSON.parse(text) : {});
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(body);
        req.end();
    });
}

// Check connectivity
try {
    await callMcp('cocos_editor', { action: 'project_info' });
} catch {
    console.error('❌ Cannot connect to MCP at', MCP_URL);
    console.error('   Make sure editor is running and plugin is loaded.');
    process.exit(1);
}

console.log(`Connected. Running auto_knowledge(save:true) for ${ALL.length} components...\n`);

let ok = 0, fail = 0, withDefaults = 0;

for (const comp of ALL) {
    try {
        const r = await callMcp('cocos_devtools', { action: 'auto_knowledge', componentType: comp, save: true });
        if (r.success) {
            ok++;
            const hasRuntime = r.data?.hasRuntimeDefaults;
            if (hasRuntime) withDefaults++;
            const propCount = Object.keys(r.data?.recommendedKnowledge?.properties || {}).length;
            console.log(`  ✅ ${comp.padEnd(35)} ${propCount} props ${hasRuntime ? '(+defaults)' : '(dts only)'}`);
        } else {
            fail++;
            console.log(`  ❌ ${comp}: ${r.error}`);
        }
    } catch (e) {
        fail++;
        console.log(`  ❌ ${comp}: ${e.message}`);
    }
}

console.log(`\nDone: ${ok} ok, ${fail} fail, ${withDefaults} with runtime defaults`);
