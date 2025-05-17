const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 5000;

// Enable CORS
app.use(cors());

// Store active FFmpeg processes and their associated files
const activeProcesses = new Map();

// Resource management settings
const CONCURRENT_PROCESSES = 2; // Limit concurrent processing
const CLEANUP_INTERVAL = 5 * 60 * 1000; // Cleanup every 5 minutes
const MAX_STORAGE_GB = 10; // Maximum storage in GB
const COMPRESSION_QUALITY = 18; // FFmpeg CRF value (lower = better quality, 18 is visually lossless)

// Configure multer for video upload with size limits and file type restrictions
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename with timestamp
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

// Configure upload middleware with limits
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5GB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed!'));
    }
  }
});

// Create clips directory if it doesn't exist
const clipsDir = path.join(__dirname, 'clips');
if (!fs.existsSync(clipsDir)) {
  fs.mkdirSync(clipsDir);
}

// Function to get total storage used
const getTotalStorageUsed = () => {
  let totalSize = 0;
  
  // Check uploads directory
  const uploadDir = path.join(__dirname, 'uploads');
  if (fs.existsSync(uploadDir)) {
    fs.readdirSync(uploadDir).forEach(file => {
      try {
        totalSize += fs.statSync(path.join(uploadDir, file)).size;
      } catch (err) {
        console.error('Error getting file size:', err);
      }
    });
  }

  // Check clips directory
  if (fs.existsSync(clipsDir)) {
    fs.readdirSync(clipsDir).forEach(file => {
      try {
        totalSize += fs.statSync(path.join(clipsDir, file)).size;
      } catch (err) {
        console.error('Error getting file size:', err);
      }
    });
  }

  return totalSize;
};

// Function to check if we have enough storage
const hasEnoughStorage = (newFileSize) => {
  const totalUsed = getTotalStorageUsed();
  const maxStorage = MAX_STORAGE_GB * 1024 * 1024 * 1024;
  return (totalUsed + newFileSize) <= maxStorage;
};

// Function to clean up files and kill process
const cleanupProcess = (requestId) => {
  if (activeProcesses.has(requestId)) {
    const { process, files } = activeProcesses.get(requestId);
    
    // Kill the FFmpeg process
    try {
      if (process && process.kill) {
        process.kill('SIGKILL');
        console.log(`Killed FFmpeg process for request ${requestId}`);
      }
    } catch (err) {
      console.error('Error killing process:', err);
    }

    // Remove from active processes
    activeProcesses.delete(requestId);
    console.log(`Cleaned up process for request ${requestId}`);
  }
};

// Function to clean up old files (older than 5 minutes)
const cleanupOldFiles = () => {
  const now = Date.now();
  const maxAge = 5 * 60 * 1000; // 5 minutes in milliseconds
  let totalCleaned = 0;
  let totalSizeCleaned = 0;

  // Get list of files currently being processed
  const activeFiles = new Set();
  for (const { files } of activeProcesses.values()) {
    files.forEach(file => activeFiles.add(file));
  }

  // Clean up uploads directory
  const uploadDir = path.join(__dirname, 'uploads');
  if (fs.existsSync(uploadDir)) {
    fs.readdirSync(uploadDir).forEach(file => {
      const filePath = path.join(uploadDir, file);
      try {
        // Skip if file is being processed
        if (activeFiles.has(filePath)) {
          console.log(`Skipping active file in cleanup: ${file}`);
          return;
        }

        const stats = fs.statSync(filePath);
        if (now - stats.mtime.getTime() > maxAge) {
          const fileSize = stats.size;
          fs.unlinkSync(filePath);
          totalCleaned++;
          totalSizeCleaned += fileSize;
          console.log(`Deleted old upload file: ${file} (${(fileSize / (1024 * 1024)).toFixed(2)} MB)`);
        }
      } catch (err) {
        console.error('Error handling upload file:', file, err);
      }
    });
  }

  // Clean up clips directory
  if (fs.existsSync(clipsDir)) {
    fs.readdirSync(clipsDir).forEach(folder => {
      const folderPath = path.join(clipsDir, folder);
      if (fs.statSync(folderPath).isDirectory() && /^project \d+$/.test(folder)) {
        try {
          // Check if any file in this project folder is in use by any active process
          let isActive = false;
          for (const { files } of activeProcesses.values()) {
            for (const file of files) {
              if (file.startsWith(folderPath)) {
                isActive = true;
                break;
              }
            }
            if (isActive) break;
          }
          if (isActive) {
            console.log(`Skipping active project folder in cleanup: ${folder}`);
            return;
          }
          const stats = fs.statSync(folderPath);
          if (now - stats.mtime.getTime() > maxAge) {
            fs.rmSync(folderPath, { recursive: true, force: true });
            console.log(`Deleted old project folder: ${folderPath}`);
          }
        } catch (err) {
          console.error('Error handling project folder:', folder, err);
        }
      }
    });
  }

  if (totalCleaned > 0) {
    console.log(`Cleanup summary: Deleted ${totalCleaned} files, freed ${(totalSizeCleaned / (1024 * 1024)).toFixed(2)} MB`);
  }
};

// Process video endpoint
app.post('/upload', upload.single('video'), async (req, res) => {
  console.log('Received /upload request');
  // Find the next project number
  const existingProjects = fs.readdirSync(clipsDir)
    .filter(f => /^project \d+$/.test(f))
    .map(f => parseInt(f.split(' ')[1]))
    .filter(n => !isNaN(n));
  const nextProjectNum = existingProjects.length > 0 ? Math.max(...existingProjects) + 1 : 1;
  const projectFolder = `project ${nextProjectNum}`;
  const projectPath = path.join(clipsDir, projectFolder);
  if (!fs.existsSync(projectPath)) fs.mkdirSync(projectPath);

  console.log('Received upload request');
  console.log('req.body:', req.body);
  console.log('req.file:', req.file);
  const requestId = Date.now().toString();
  const clips = [];
  const filesToCleanup = new Set();
  const customMessage = req.body.customMessage || '';
  const fontStyle = req.body.fontStyle || 'Arial';

  // Check concurrent processes limit
  if (activeProcesses.size >= CONCURRENT_PROCESSES) {
    return res.status(429).json({ error: 'Server is busy. Please try again later.' });
  }

  // Add uploaded file to cleanup list
  if (req.file) {
    // Check storage limit
    if (!hasEnoughStorage(req.file.size)) {
      fs.unlinkSync(req.file.path);
      return res.status(507).json({ error: 'Server storage limit reached. Please try again later.' });
    }
    filesToCleanup.add(req.file.path);
    console.log(`Received upload: ${req.file.originalname} (${(req.file.size / (1024 * 1024)).toFixed(2)} MB)`);
  }

  // Handle client disconnect
  req.on('close', () => {
    console.log('Client disconnected, cleaning up process...');
    cleanupProcess(requestId);
  });

  // Handle client abort
  req.on('aborted', () => {
    console.log('Client aborted request, cleaning up process...');
    cleanupProcess(requestId);
  });

  // Handle errors
  req.on('error', (err) => {
    console.error('Request error:', err);
    cleanupProcess(requestId);
  });

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    const inputPath = req.file.path;

    // Get video duration
    const duration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) reject(err);
        resolve(metadata.format.duration);
      });
    });

    console.log(`Processing video: ${duration.toFixed(2)} seconds duration`);

    // Split video into 2-minute segments
    const segmentDuration = 120; // 2 minutes in seconds
    const numSegments = Math.ceil(duration / segmentDuration);
    console.log(`Will create ${numSegments} segments`);

    let processedClips = 0;
    let failedClips = 0;

    for (let i = 0; i < numSegments; i++) {
      try {
        const startTime = i * segmentDuration;
        const outputPath = path.join(projectPath, `part${i + 1}.mp4`);
        filesToCleanup.add(outputPath);
        
        await new Promise((resolve, reject) => {
          const command = ffmpeg(inputPath)
            .setStartTime(startTime)
            .setDuration(segmentDuration)
            .size('540x960') // 9:16 aspect ratio
            .videoFilters([
              'scale=540:960:force_original_aspect_ratio=decrease',
              'pad=540:960:(ow-iw)/2:(oh-ih)/2',
              // Part number text
              {
                filter: 'drawtext',
                options: {
                  text: `Part ${i + 1}`,
                  fontsize: 24,
                  fontcolor: 'white',
                  x: '(w-text_w)/2',
                  y: 'h*0.2',
                  box: 1,
                  boxcolor: 'black@0.5',
                  boxborderw: 5,
                  font: fontStyle,
                  shadowcolor: 'black@0.5',
                  shadowx: 2,
                  shadowy: 2
                }
              },
              // Custom message text
              ...(customMessage ? [{
                filter: 'drawtext',
                options: {
                  text: customMessage,
                  fontsize: 28,
                  fontcolor: 'white',
                  x: '(w-text_w)/2',
                  y: 'h*0.25',
                  box: 1,
                  boxcolor: 'black@0.5',
                  boxborderw: 5,
                  font: fontStyle,
                  shadowcolor: 'black@0.5',
                  shadowx: 2,
                  shadowy: 2
                }
              }] : []),
              // Watermark
              {
                filter: 'drawtext',
                options: {
                  text: '@short.toons_',
                  fontsize: 20,
                  fontcolor: 'white@0.1',
                  x: '(w-text_w)/2',
                  y: 'h*0.71',
                  font: fontStyle
                }
              }
            ])
            .videoCodec('libx264')
            .videoBitrate('4000k')
            .fps(30)
            .outputOptions([
              `-crf ${COMPRESSION_QUALITY}`,
              '-preset slower',
              '-movflags +faststart',
              '-profile:v high',
              '-level 4.1',
              '-x264-params ref=4:me=umh:subme=8:trellis=2',
              '-pix_fmt yuv420p'
            ])
            .output(outputPath);

          // Store the process and its associated files
          activeProcesses.set(requestId, {
            process: command,
            files: Array.from(filesToCleanup)
          });

          command
            .on('start', (commandLine) => {
              console.log(`Started processing segment ${i + 1}`);
            })
            .on('progress', (progress) => {
              if (progress && progress.percent) {
                console.log(`Processing segment ${i + 1}: ${progress.percent.toFixed(2)}% done`);
              }
            })
            .on('end', () => {
              try {
                const stats = fs.statSync(outputPath);
                console.log(`Segment ${i + 1} processed (${(stats.size / (1024 * 1024)).toFixed(2)} MB)`);
                clips.push({
                  path: outputPath,
                  filename: `part${i + 1}.mp4`,
                  part: i + 1,
                  url: `/clips/${projectFolder}/part${i + 1}.mp4`
                });
                processedClips++;
                activeProcesses.delete(requestId);
                resolve();
              } catch (err) {
                console.error(`Error accessing processed segment ${i + 1}:`, err);
                failedClips++;
                resolve(); // Continue with next segment
              }
            })
            .on('error', (err) => {
              console.error(`Error processing segment ${i + 1}:`, err);
              failedClips++;
              activeProcesses.delete(requestId);
              resolve(); // Continue with next segment
            })
            .run();
        });
      } catch (segmentError) {
        console.error(`Error processing segment ${i + 1}:`, segmentError);
        failedClips++;
        // Continue with next segment
      }
    }

    // Clean up the original uploaded file
    try {
      const originalSize = fs.statSync(inputPath).size;
      fs.unlinkSync(inputPath);
      console.log(`Cleaned up original file (${(originalSize / (1024 * 1024)).toFixed(2)} MB)`);
    } catch (cleanupError) {
      console.error('Error cleaning up original file:', cleanupError);
    }

    // Send response with processing summary
    res.json({ 
      project: projectFolder, 
      clips, 
      duration, 
      numSegments,
      processingSummary: {
        totalSegments: numSegments,
        processedClips,
        failedClips,
        success: processedClips > 0
      }
    });
  } catch (error) {
    console.error('Error processing video:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      code: error.code
    });
    cleanupProcess(requestId);
    res.status(500).json({ 
      error: 'Error processing video: ' + error.message,
      processingSummary: {
        totalSegments: numSegments || 0,
        processedClips: processedClips || 0,
        failedClips: failedClips || 0,
        success: false
      }
    });
  }
});

// Serve processed clips
app.use('/clips', express.static(clipsDir, {
  setHeaders: (res, path) => {
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Access-Control-Allow-Origin', '*');
  }
}));

// Add a specific route for project folders
app.get('/clips/:project/:filename', (req, res) => {
  const { project, filename } = req.params;
  const filePath = path.join(clipsDir, project, filename);
  
  if (fs.existsSync(filePath)) {
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.set('Content-Type', 'video/mp4');
    res.sendFile(filePath, (err) => {
      if (err) {
        console.error('Error sending file:', err);
        res.status(500).send('Error sending file');
      }
    });
  } else {
    console.error(`File not found: ${filePath}`);
    res.status(404).send('File not found');
  }
});

// Clean up old project folders periodically
setInterval(() => {
  const now = Date.now();
  const maxAge = 5 * 60 * 1000; // 5 minutes
  fs.readdirSync(clipsDir).forEach(folder => {
    const folderPath = path.join(clipsDir, folder);
    if (fs.statSync(folderPath).isDirectory() && /^project \d+$/.test(folder)) {
      const stats = fs.statSync(folderPath);
      if (now - stats.mtime.getTime() > maxAge) {
        fs.rmSync(folderPath, { recursive: true, force: true });
        console.log(`Deleted old project folder: ${folderPath}`);
      }
    }
  });
}, CLEANUP_INTERVAL);

// Handle server shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, cleaning up...');
  // Clean up all active processes
  for (const [requestId] of activeProcesses) {
    cleanupProcess(requestId);
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, cleaning up...');
  // Clean up all active processes
  for (const [requestId] of activeProcesses) {
    cleanupProcess(requestId);
  }
  process.exit(0);
});

// Serve static files from the React app
app.use(express.static(path.join(__dirname, 'client', 'build')));

// The "catchall" handler: for any request that doesn't match an API route, send back React's index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'build', 'index.html'));
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

ffmpeg.getAvailableFormats(function(err, formats) {
  if (err) {
    console.error('FFmpeg is NOT available:', err);
  } else {
    console.log('FFmpeg is available!');
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});