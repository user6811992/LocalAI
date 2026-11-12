s = open('server.js', encoding='utf-8').read()
old = "const ERROR_LOG_FILE = path.join(DATA_DIR, 'error.log');"
new = "const ERROR_LOG_FILE = path.join(__dirname, 'error.log');"
assert old in s
s = s.replace(old, new)
# Remove the mkdirSync line
old2 = "    const fs = require('fs');\n    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}\n"
new2 = "    const fs = require('fs');\n"
assert old2 in s
s = s.replace(old2, new2)
open('server.js', 'w', encoding='utf-8').write(s)
print('reverted L4')
