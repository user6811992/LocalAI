s = open('server.js', encoding='utf-8').read()
old = "const ERROR_LOG_FILE = path.join(__dirname, 'error.log');"
new = "const ERROR_LOG_FILE = path.join(DATA_DIR, 'error.log');"
assert old in s, 'old not found'
s = s.replace(old, new)
old2 = "function logError(context, error) {\n  try {\n    const fs = require('fs');"
new2 = "function logError(context, error) {\n  try {\n    const fs = require('fs');\n    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}"
assert old2 in s, 'old2 not found'
s = s.replace(old2, new2)
open('server.js', 'w', encoding='utf-8').write(s)
print('done')
