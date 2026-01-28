// Script simples para resetar a password de um utilizador no MongoDB
// Uso: node reset_user_password.js <email> <nova_password>

const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const MONGODB_URI = "mongodb+srv://patrick_mongo:12344@sinf2.ymbvmi4.mongodb.net/?appName=SINF2";
const MONGODB_DB = process.env.MONGODB_DB || 'kynex';

function hashPasswordScrypt(password, saltB64) {
  const salt = Buffer.from(saltB64, 'base64');
  const keyLen = 64;
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLen, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey.toString('base64'));
    });
  });
}

function genSalt() {
  return crypto.randomBytes(16).toString('base64');
}

async function main() {
  const [,, email, newPassword] = process.argv;
  if (!email || !newPassword) {
    console.error('Uso: node reset_user_password.js <email> <nova_password>');
    process.exit(1);
  }

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(MONGODB_DB);
  const users = db.collection('users');

  const user = await users.findOne({ email });
  if (!user) {
    console.error('Utilizador não encontrado:', email);
    process.exit(2);
  }

  const saltB64 = genSalt();
  const hashB64 = await hashPasswordScrypt(newPassword, saltB64);

  await users.updateOne(
    { email },
    { $set: { password_salt_b64: saltB64, password_hash_b64: hashB64 } }
  );

  console.log('Password atualizada com sucesso para', email);
  await client.close();
}

main().catch((err) => {
  console.error('Erro:', err);
  process.exit(3);
});
