#!/usr/bin/env node
const postcss = require('postcss');
const tailwindcss = require('tailwindcss');
const autoprefixer = require('autoprefixer');
const fs = require('fs');
const path = require('path');

const inputFile = path.join(__dirname, 'public', 'styles.css');
const outputDir = path.join(__dirname, 'public', 'dist');
const outputFile = path.join(outputDir, 'styles.css');

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Read input
const input = fs.readFileSync(inputFile, 'utf8');

// Process with PostCSS
postcss([
  tailwindcss(path.join(__dirname, 'tailwind.config.js')),
  autoprefixer,
]).process(input, { from: inputFile, to: outputFile })
  .then(result => {
    fs.writeFileSync(outputFile, result.css);
    console.log(`✓ CSS built to ${outputFile} (${result.css.length} bytes)`);
  })
  .catch(err => {
    console.error('✗ CSS build failed:', err.message);
    process.exit(1);
  });
