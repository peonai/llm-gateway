import Database from 'better-sqlite3';
const db = new Database('./gateway.db');

// 查表结构
console.log('=== Tables ===');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log(tables);

// 查 deployments 表结构
console.log('\n=== Deployments Schema ===');
const schema = db.prepare("PRAGMA table_info(deployments)").all();
console.log(schema);

// 查所有 deployments
console.log('\n=== All Deployments ===');
const deployments = db.prepare("SELECT * FROM deployments").all();
console.log(JSON.stringify(deployments, null, 2));

// 查 request_logs 表结构
console.log('\n=== Request Logs Schema ===');
const logSchema = db.prepare("PRAGMA table_info(request_logs)").all();
console.log(logSchema);

// 查最近失败的请求
console.log('\n=== Recent Failed Requests ===');
const failedLogs = db.prepare("SELECT * FROM request_logs WHERE status != 200 ORDER BY createdAt DESC LIMIT 5").all();
console.log(JSON.stringify(failedLogs, null, 2));

// 查 sssaicode 相关的 provider
console.log('\n=== Providers (sssaicode) ===');
const providers = db.prepare("SELECT * FROM providers WHERE id IN (SELECT providerId FROM deployments WHERE modelName LIKE '%opus%')").all();
console.log(JSON.stringify(providers, null, 2));

db.close();
