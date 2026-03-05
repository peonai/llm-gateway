import Database from 'better-sqlite3';
const db = new Database('./gateway.db');

// 把所有 opus 部署的 timeout 改成 180 秒
const result = db.prepare(`
  UPDATE deployments 
  SET timeout = 180 
  WHERE modelName LIKE '%opus%'
`).run();

console.log(`✅ Updated ${result.changes} opus deployments to 180s timeout`);

// 验证
const updated = db.prepare("SELECT id, modelName, providerId, timeout, `order` FROM deployments WHERE modelName LIKE '%opus%' ORDER BY `order`").all();
console.log('\n=== Updated Opus Deployments ===');
console.log(JSON.stringify(updated, null, 2));

db.close();
