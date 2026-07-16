const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');
code = code.replace(
    /log\(\`\\[WhatsApp Inbound\\] Erro ao baixar media auto: \$\{e.message\}\`\);/,
    "log(`[WhatsApp Inbound] Erro ao baixar media auto (ignorado): ${e.message}`);"
);
fs.writeFileSync('server.js', code);
