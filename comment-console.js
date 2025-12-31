const fs = require('fs');
const path = require('path');

function commentConsoleStatements(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });

  for (const file of files) {
    const fullPath = path.join(dir, file.name);

    if (file.isDirectory()) {
      // Skip node_modules and other non-source directories
      if (!['node_modules', '.git', 'dist', 'build'].includes(file.name)) {
        commentConsoleStatements(fullPath);
      }
    } else if (file.name.endsWith('.ts') || file.name.endsWith('.js')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      let modified = false;

      // Comment out console.log, console.error, console.warn, console.info, console.debug
      // Match patterns like: console.log(...) or console.error(...)
      // Preserve indentation
      const patterns = [
        /(\s*)(console\.log\()/g,
        /(\s*)(console\.error\()/g,
        /(\s*)(console\.warn\()/g,
        /(\s*)(console\.info\()/g,
        /(\s*)(console\.debug\()/g,
      ];

      patterns.forEach(pattern => {
        if (pattern.test(content)) {
          content = content.replace(pattern, '$1// $2');
          modified = true;
        }
      });

      if (modified) {
        fs.writeFileSync(fullPath, content, 'utf8');
        console.log(`Commented console statements in: ${fullPath}`);
      }
    }
  }
}

// Start from src directory
const srcDir = path.join(__dirname, 'src');
if (fs.existsSync(srcDir)) {
  commentConsoleStatements(srcDir);
  console.log('Done! All console statements have been commented out.');
} else {
  console.error('src directory not found!');
}

