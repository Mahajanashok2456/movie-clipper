import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './App.css';

function App() {
  const [file, setFile] = useState(null);
  const [clips, setClips] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState(null);
  const [timeLeft, setTimeLeft] = useState(5 * 60); // 5 minutes in seconds
  const [downloading, setDownloading] = useState(false);
  const [cancelToken, setCancelToken] = useState(null);
  const [customMessage, setCustomMessage] = useState('');
  const [fontStyle, setFontStyle] = useState('Arial');
  const [fileInfo, setFileInfo] = useState(null);
  const [durationEstimate, setDurationEstimate] = useState(null);
  const [partEstimate, setPartEstimate] = useState(null);
  const [timeEstimate, setTimeEstimate] = useState(null);

  useEffect(() => {
    let timer;
    if (clips.length > 0) {
      timer = setInterval(() => {
        setTimeLeft(prev => {
          if (prev <= 0) {
            clearInterval(timer);
            setClips([]);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [clips]);

  const formatTime = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    setFile(selectedFile);
    if (selectedFile) {
      setFileInfo({
        name: selectedFile.name,
        size: (selectedFile.size / (1024 * 1024)).toFixed(2) + ' MB',
      });
      // Try to get video duration in browser
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.onloadedmetadata = function() {
        window.URL.revokeObjectURL(video.src);
        const duration = video.duration;
        setDurationEstimate(duration);
        const parts = Math.ceil(duration / 120);
        setPartEstimate(parts);
        // Estimate 10s per part (adjust as needed)
        setTimeEstimate(parts * 10);
      };
      video.src = URL.createObjectURL(selectedFile);
    } else {
      setFileInfo(null);
      setDurationEstimate(null);
      setPartEstimate(null);
      setTimeEstimate(null);
    }
  };

  const handleCancel = () => {
    if (cancelToken) {
      cancelToken.cancel('Operation cancelled by user');
      setUploading(false);
      setUploadProgress(0);
      setError('Operation cancelled');
      setCancelToken(null);
    }
  };

  const handleUpload = async () => {
    if (!file) {
      setError('Please select a video file');
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    setError(null);
    setClips([]);

    const formData = new FormData();
    formData.append('video', file);
    formData.append('customMessage', customMessage);
    formData.append('fontStyle', fontStyle);

    // Create a new cancel token
    const source = axios.CancelToken.source();
    setCancelToken(source);

    try {
      const response = await axios.post('/upload', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        onUploadProgress: (progressEvent) => {
          const progress = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          setUploadProgress(progress);
        },
        cancelToken: source.token
      });

      const { clips: processedClips, processingSummary } = response.data;
      
      if (processingSummary.success) {
        setClips(processedClips.map((clip, index) => ({
          ...clip,
          part: index + 1,
          filename: `part${index + 1}.mp4`,
          url: `http://localhost:5000/clips/${response.data.project}/part${index + 1}.mp4`
        })));
        setTimeLeft(5 * 60); // Reset to 5 minutes

        if (processingSummary.failedClips > 0) {
          setError(`Warning: ${processingSummary.failedClips} out of ${processingSummary.totalSegments} clips failed to process. The successful clips are available for download.`);
        }
      } else {
        setError('No clips were successfully processed. Please try again.');
      }
    } catch (err) {
      if (axios.isCancel(err)) {
        setError('Operation cancelled');
      } else {
        const errorMessage = err.response?.data?.error || 'Error processing video';
        const processingSummary = err.response?.data?.processingSummary;
        
        if (processingSummary && processingSummary.processedClips > 0) {
          setError(`${errorMessage}. However, ${processingSummary.processedClips} clips were successfully processed and are available for download.`);
          setClips(processingSummary.clips || []);
        } else {
          setError(errorMessage);
        }
      }
    } finally {
      setUploading(false);
      setCancelToken(null);
    }
  };

  const downloadAllClips = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        const link = document.createElement('a');
        link.href = clip.url;
        link.download = `part${i + 1}.mp4`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        // Wait a bit between downloads to prevent browser issues
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (err) {
      setError('Error downloading clips. Please try downloading them individually.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="App" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: 'none' }}>
      <header style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: '2.8em', color: '#ff6a00', letterSpacing: 2, textShadow: '0 0 20px #ff61a6, 0 2px 8px #0008', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <span role="img" aria-label="movie">🎬</span> Movie Clipper
        </h1>
        <p className="subtitle" style={{ color: '#fff', fontSize: '1.25em', margin: 0, textShadow: '0 1px 8px #0006' }}>
          Instantly split your large video into 2-minute clips!
        </p>
      </header>

      {/* Step Indicator */}
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', marginBottom: 32, gap: 24 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ background: '#4CAF50', color: '#fff', borderRadius: '50%', width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, marginBottom: 6, boxShadow: '0 2px 8px #4caf5040' }}>
            <i className="fas fa-upload"></i>
          </div>
          <span style={{ fontSize: 13, color: '#fff' }}>Upload</span>
        </div>
        <div style={{ width: 40, height: 2, background: '#ff61a6', borderRadius: 2 }}></div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ background: '#ff61a6', color: '#fff', borderRadius: '50%', width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, marginBottom: 6, boxShadow: '0 2px 8px #ff61a640' }}>
            <i className="fas fa-magic"></i>
          </div>
          <span style={{ fontSize: 13, color: '#fff' }}>Type a message</span>
        </div>
        <div style={{ width: 40, height: 2, background: '#00c3ff', borderRadius: 2 }}></div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ background: '#00c3ff', color: '#fff', borderRadius: '50%', width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, marginBottom: 6, boxShadow: '0 2px 8px #00c3ff40' }}>
            <i className="fas fa-download"></i>
          </div>
          <span style={{ fontSize: 13, color: '#fff' }}>Download</span>
        </div>
      </div>

      <div className="container">
        <div className="upload-section" style={{ margin: '0 auto', maxWidth: 420, background: 'rgba(255,255,255,0.10)', borderRadius: 18, boxShadow: '0 8px 32px rgba(31,38,135,0.18)', padding: 32, border: '2px solid #4CAF50', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div className="custom-message-section" style={{ marginBottom: 30, width: '100%' }}>
            <div className="input-group">
              <label htmlFor="customMessage">Add Your Message:</label>
              <input
                type="text"
                id="customMessage"
                value={customMessage}
                onChange={e => setCustomMessage(e.target.value)}
                placeholder="Type your message to display on video clips"
                style={{ width: '90%', padding: 14, borderRadius: 8, border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.1)', color: '#fff', fontSize: '1em', marginBottom: 20, marginright: '10%' }}
              />
            </div>
            <div className="input-group">
              <label htmlFor="fontStyle">Choose Font Style:</label>
              <select
                id="fontStyle"
                value={fontStyle}
                onChange={e => setFontStyle(e.target.value)}
                style={{ width: '100%', padding: 14, borderRadius: 8, border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.1)', color: '#fff', fontSize: '1em' }}
              >
                <option value="Arial">Arial</option>
                <option value="Helvetica">Helvetica</option>
                <option value="Times New Roman">Times New Roman</option>
                <option value="Courier New">Courier New</option>
                <option value="Georgia">Georgia</option>
                <option value="Verdana">Verdana</option>
                <option value="Impact">Impact</option>
                <option value="Comic Sans MS">Comic Sans MS</option>
              </select>
            </div>
          </div>
          {fileInfo && (
            <div style={{marginBottom: 16, color: '#fff', background: 'rgba(0,0,0,0.12)', borderRadius: 8, padding: 12, fontSize: 15}}>
              <div><b>File:</b> {fileInfo.name} ({fileInfo.size})</div>
              {durationEstimate && (
                <>
                  <div><b>Duration:</b> {Math.round(durationEstimate)} seconds</div>
                  <div><b>Parts:</b> {partEstimate} (2 min each)</div>
                  <div><b>Estimated processing time:</b> ~{timeEstimate} seconds</div>
                </>
              )}
            </div>
          )}
          <input
            type="file"
            accept="video/*"
            onChange={handleFileChange}
            className="file-input"
            disabled={uploading}
          />
          <div className="button-group" style={{ width: '100%' }}>
            <button
              onClick={handleUpload}
              disabled={!file || uploading}
              className="upload-button"
            >
              {uploading ? 'Processing...' : 'Upload Video'}
            </button>
            {uploading && (
              <button
                onClick={handleCancel}
                className="cancel-button"
              >
                Cancel
              </button>
            )}
          </div>

          {uploading && (
            <div className="progress-container">
              <div
                className="progress-bar"
                style={{ width: `${uploadProgress}%` }}
              />
              <span className="progress-text">{uploadProgress}%</span>
            </div>
          )}

          {error && <div className="error">{error}</div>}
        </div>

        {clips.length > 0 && (
          <div className="clips-section">
            <div className="clips-header">
              <h2>Generated Clips</h2>
              <div className="clips-info">
                <p className="disclaimer">⚠️ Clips will be automatically deleted in {formatTime(timeLeft)}. Please download them quickly!</p>
              </div>
            </div>
            <div className="clips-grid">
              {clips.map((clip, index) => (
                <div key={index} className="clip-card">
                  <video src={clip.url} controls />
                  <a
                    href={clip.url}
                    className="download-button"
                    download={`part${index + 1}.mp4`}
                  >
                    Download Part {index + 1}
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <footer style={{ marginTop: 40, color: '#fff', opacity: 0.7, fontSize: 15, letterSpacing: 1 }}>
        <span role="img" aria-label="copyright">©️</span> {new Date().getFullYear()} Movie Clipper &mdash; Made with <span role="img" aria-label="heart">❤️</span> by MAHAJAN ASHOK
      </footer>
    </div>
  );
}

export default App;
