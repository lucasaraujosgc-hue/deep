const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

code = code.replace(
    /const limitParam = parseInt\\(req\\.query\\.limit\\) \\|\\| 50;/g,
    "const limitParam = parseInt(req.query.limit) || 50;\n        await ensureWaInjection(wrapper.client);"
);

code = code.replace(
    /const db = getDb\\(req\\.user\\);\n        let kanbanCards = \\[\\];/g,
    "await ensureWaInjection(wrapper.client);\n        const db = getDb(req.user);\n        let kanbanCards = [];"
);

fs.writeFileSync('server.js', code);
console.log("Patched ensure 2");
