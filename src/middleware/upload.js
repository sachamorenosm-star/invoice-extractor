const multer = require('multer');

// GDPR: SOLO memoryStorage. I file non devono MAI toccare il disco.
// Vengono tenuti come Buffer in RAM (req.files[i].buffer), inviati a Claude
// per l'elaborazione ed eliminati automaticamente al termine della request
// (garbage collection, nessuna persistenza).
const storage = multer.memoryStorage();

const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 10;
const MAX_FILES_PER_REQUEST = parseInt(process.env.MAX_FILES_PER_REQUEST, 10) || 10;
const ALLOWED_MIME_TYPES = (process.env.ALLOWED_MIME_TYPES ||
  'application/pdf,image/jpeg,image/png,image/webp'
).split(',').map((t) => t.trim());

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(new Error(`Tipo di file non supportato: ${file.mimetype}`));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE_MB * 1024 * 1024,
    files: MAX_FILES_PER_REQUEST,
  },
});

module.exports = {
  upload,
  MAX_FILE_SIZE_MB,
  MAX_FILES_PER_REQUEST,
  ALLOWED_MIME_TYPES,
};
