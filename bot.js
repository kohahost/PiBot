const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const axios = require('axios');
require('dotenv').config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MNEMONIC = process.env.MNEMONIC;
const RECEIVER_ADDRESS = process.env.RECEIVER_ADDRESS;

const server = new StellarSdk.Server('https://api.mainnet.minepi.com');

async function getKeypairFromMnemonic(mnemonic) {
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const { key } = ed25519.derivePath("m/44'/314159'/0'", seed.toString('hex'));
  return StellarSdk.Keypair.fromRawEd25519Seed(key);
}

async function notifyTelegram(message) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "Markdown"
    });
  } catch (e) {
    console.error("❌ Gagal kirim Telegram:", e.message);
  }
}

async function claimBalances(publicKey, keypair) {
  const url = `https://api.mainnet.minepi.com/claimable_balances?claimant=${publicKey}&limit=100`;
  const res = await axios.get(url);
  const records = res.data._embedded?.records || [];

  if (records.length === 0) return false;

  for (const claim of records) {
    try {
      const account = await server.loadAccount(publicKey);
      const baseFee = await server.fetchBaseFee();

      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: baseFee.toString(),
        networkPassphrase: 'Pi Network',
      })
        .addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId: claim.id }))
        .setTimeout(30)
        .build();

      tx.sign(keypair);
      await server.submitTransaction(tx);
      console.log(`✅ Klaim sukses: ${claim.id}`);
    } catch (e) {
      console.log(`⚠️ Gagal klaim: ${claim.id}`, e?.response?.data || e.message);
    }
  }

  return true;
}

async function sendBalance(publicKey, keypair) {
  const res = await axios.get(`https://api.mainnet.minepi.com/accounts/${publicKey}`);
  const native = res.data.balances.find(b => b.asset_type === 'native');
  const balance = parseFloat(native?.balance || '0');

  if (balance <= 0.02) return false;

  const sendAmount = (balance - 0.01).toFixed(7);
  const account = await server.loadAccount(publicKey);
  const baseFee = await server.fetchBaseFee();

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: baseFee.toString(),
    networkPassphrase: 'Pi Network',
  })
    .addOperation(StellarSdk.Operation.payment({
      destination: RECEIVER_ADDRESS,
      asset: StellarSdk.Asset.native(),
      amount: sendAmount,
    }))
    .setTimeout(30)
    .build();

  tx.sign(keypair);
  const result = await server.submitTransaction(tx);

  if (result?.hash) {
    const link = `https://api.mainnet.minepi.com/transactions/${result.hash}`;
    console.log(`✅ Kirim sukses: ${sendAmount} Pi`);
    await notifyTelegram(`✅ Berhasil kirim ${sendAmount} Pi\n🔗 ${link}`);
    return true;
  }

  return false;
}

(async function monitor() {
  const keypair = await getKeypairFromMnemonic(MNEMONIC);
  const publicKey = keypair.publicKey();
  let lastBalance = 0;

  console.log(`🚀 Monitoring wallet: ${publicKey}`);

  while (true) {
    try {
      const res = await axios.get(`https://api.mainnet.minepi.com/accounts/${publicKey}`);
      const native = res.data.balances.find(b => b.asset_type === 'native');
      const balance = parseFloat(native?.balance || '0');

      if (balance !== lastBalance) {
        console.log(`💰 Saldo berubah: ${lastBalance} -> ${balance}`);
        lastBalance = balance;

        const claimed = await claimBalances(publicKey, keypair);
        const sent = await sendBalance(publicKey, keypair);

        if (!claimed && !sent) {
          console.log("ℹ️ Tidak ada yang bisa diklaim/dikirim.");
        }
      }
    } catch (e) {
      console.error("❌ Error saat proses:", e?.response?.data || e.message);
    }

    await new Promise(resolve => setTimeout(resolve, 449)); // Delay pasif (449 ms)
  }
})();
