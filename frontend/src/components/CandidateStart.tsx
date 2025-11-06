import { useState, useEffect, useRef } from 'react';
import InterviewSession from './InterviewSession';
import { getApiHeaders } from '../utils/api';
import { uploadCandidateImage } from '../utils/api';

interface Props { apiBaseUrl: string; interviewId: string }

export default function CandidateStart({ apiBaseUrl, interviewId }: Props) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [started, setStarted] = useState(false);
  const [isOpen, setIsOpen] = useState<boolean | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [statusError, setStatusError] = useState('');
  const [accessError, setAccessError] = useState('');
  const [actualInterviewId, setActualInterviewId] = useState<string>('');
  const [responseId, setResponseId] = useState<string | null>(null);
  
  // Camera and image capture states
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoUploaded, setPhotoUploaded] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  
  // Screen recording permission
  const [screenPermissionGranted, setScreenPermissionGranted] = useState(false);
  const [screenShareStream, setScreenShareStream] = useState<MediaStream | null>(null);
  
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const checkInterviewStatus = async () => {
      try {
        const res = await fetch(`${apiBaseUrl}/api/interview/list-interviews`, {
          method: 'GET',
          headers: getApiHeaders(false),
        });
        if (res.ok) {
          const responseData = await res.json();
          // Filter to find the specific interview by ID or readable_slug
          const data = responseData?.interviews?.find((i: any) => 
            i.id === interviewId || i.candidate_link?.includes(interviewId)
          ) || null;
          if (data) {
            setIsOpen(data.is_open !== false);
            setActualInterviewId(data.id);
          } else {
            setStatusError('Interview not found');
          }
        } else {
          setStatusError('Failed to load interview details');
        }
      } catch (err) {
        setStatusError('Failed to check interview status');
      } finally {
        setLoadingStatus(false);
      }
    };
    
    checkInterviewStatus();
  }, [apiBaseUrl, interviewId]);

  // Cleanup camera stream and screen share stream on unmount
  useEffect(() => {
    return () => {
      if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
      }
      // Only cleanup screen share if component is unmounting and interview hasn't started
      if (screenShareStream && !started) {
        screenShareStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [cameraStream, screenShareStream, started]);

  // Update video element when cameraStream changes
  useEffect(() => {
    if (cameraStream && videoRef.current) {
      const video = videoRef.current;
      if (video.srcObject !== cameraStream) {
        video.srcObject = cameraStream;
        video.playsInline = true;
        video.muted = true;
        video.autoplay = true;
        
        // Wait for video metadata to determine if camera is ready
        const onLoadedMetadata = () => {
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            setCameraReady(true);
          }
        };
        
        const onCanPlay = () => {
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            setCameraReady(true);
          }
        };
        
        video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
        video.addEventListener('canplay', onCanPlay, { once: true });
        
        // Check if already ready
        if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
          setCameraReady(true);
        }
        
        // Play the video
        video.play().catch(err => {
          console.warn('Video play failed:', err);
        });
      }
    } else if (!cameraStream && videoRef.current) {
      // Clear video element when stream is removed
      videoRef.current.srcObject = null;
      setCameraReady(false);
    }
  }, [cameraStream]);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { 
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }, 
        audio: false 
      });
      
      // Set the stream state - useEffect will handle attaching it to video element
      setCameraStream(stream);
    } catch (e) {
      setStatusError('Camera permission denied or unavailable. Please enable camera access.');
      console.error('Camera error:', e);
    }
  };

  const capturePhoto = () => {
    if (!videoRef.current || !cameraReady) {
      setAccessError('Camera not ready yet. Please wait a moment and try again.');
      return;
    }

    const video = videoRef.current;
    const canvas = canvasRef.current || document.createElement('canvas');
    canvasRef.current = canvas;

    const w = video.videoWidth || 640;
    const h = video.videoHeight || 480;

    if (w === 0 || h === 0) {
      requestAnimationFrame(() => capturePhoto());
      return;
    }

    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, w, h);
    canvas.toBlob((blob) => {
      if (blob) {
        setCapturedBlob(blob);
      }
    }, 'image/jpeg', 0.9);
  };

  const uploadPhoto = async () => {
    if (!capturedBlob) {
      setAccessError('Please capture a photo first.');
      return;
    }

    if (!responseId) {
      // Photo will be uploaded when interview starts
      setAccessError('Photo will be uploaded when you start the interview.');
      return;
    }

    setUploadingPhoto(true);
    try {
      await uploadCandidateImage(apiBaseUrl, capturedBlob, responseId, 'candidate.jpg');
      setPhotoUploaded(true);
      if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
        setCameraStream(null);
      }
    } catch (e) {
      setAccessError('Failed to upload photo. Please try again.');
      console.error('Upload error:', e);
    } finally {
      setUploadingPhoto(false);
    }
  };

  const requestScreenPermission = async () => {
    try {
      const displayStream = await (navigator.mediaDevices as any).getDisplayMedia({ 
        video: { displaySurface: 'monitor' },
        audio: true 
      });
      
      // Validate that full screen is being shared, not just a window
      const videoTrack = displayStream.getVideoTracks()[0];
      const settings = videoTrack.getSettings();
      const displaySurface = (settings as any).displaySurface;
      
      if (displaySurface !== 'monitor') {
        // Reject window/tab-only sharing
        displayStream.getTracks().forEach((track: MediaStreamTrack) => track.stop());
        setAccessError('Full screen sharing is required. Please select "Entire Screen" instead of a single window or tab.');
        return;
      }
      
      // Validate that audio is enabled during screen sharing
      const audioTracks = displayStream.getAudioTracks();
      if (audioTracks.length === 0) {
        // Audio was not enabled during screen sharing
        displayStream.getTracks().forEach((track: MediaStreamTrack) => track.stop());
        setAccessError('Please enable audio while sharing your screen. When sharing, make sure to check the "Share audio" or "Share system audio" option in the browser dialog.');
        return;
      }
      
      // Keep the stream alive - don't stop it! We'll use it in the interview session
      setScreenShareStream(displayStream);
      setScreenPermissionGranted(true);
    } catch (e) {
      setAccessError('Screen recording permission denied. Screen recording is required to proceed.');
      console.error('Screen permission error:', e);
    }
  };

  const handleStart = async () => {
    if (!name.trim() || !email.trim()) {
      setAccessError('Please provide both name and email');
      return;
    }

    // Check if photo is captured and screen permission is granted
    if (!capturedBlob) {
      setAccessError('Please capture your photo before starting the interview.');
      return;
    }

    if (!screenPermissionGranted) {
      setAccessError('Please grant screen recording permission before starting the interview.');
      return;
    }
    
    setAccessError('');
    setLoadingStatus(true);
    
    try {
      const res = await fetch(`${apiBaseUrl}/api/interview/start-interview`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          interview_id: actualInterviewId || interviewId,
          candidate_name: name.trim(),
          candidate_email: email.trim(),
        }),
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        setAccessError(data.detail || 'Failed to start interview. Please contact HR if you believe this is an error.');
        setLoadingStatus(false);
        return;
      }

      // Store response_id and upload photo
      if (data.response_id) {
        setResponseId(data.response_id);
        // Upload photo now that we have response_id
        if (capturedBlob) {
          try {
            await uploadCandidateImage(apiBaseUrl, capturedBlob, data.response_id, 'candidate.jpg');
            setPhotoUploaded(true);
          } catch (e) {
            console.error('Failed to upload photo after starting:', e);
            // Don't block interview start if photo upload fails
          }
        }
      }
      
      setStarted(true);
    } catch (err) {
      setAccessError('Network error. Please try again.');
      setLoadingStatus(false);
    }
  };

  if (started) {
    return (
      <InterviewSession
        apiBaseUrl={apiBaseUrl}
        interviewId={actualInterviewId || interviewId}
        candidateName={name || 'Anonymous'}
        candidateEmail={email || 'anonymous@example.com'}
        screenPermissionGranted={screenPermissionGranted}
        existingScreenStream={screenShareStream}
      />
    );
  }

  if (loadingStatus) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-orange-50 to-amber-50 flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-8 text-center">
          <div className="text-gray-600">Loading interview details...</div>
        </div>
      </div>
    );
  }

  if (statusError || isOpen === false) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-orange-50 to-amber-50 flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-8">
          <div className="text-center">
            <div className="text-6xl mb-4">🔒</div>
            <h1 className="text-2xl font-bold mb-2 text-red-600">Interview Closed</h1>
            <p className="text-gray-600 mb-4">
              {statusError || 'This interview is currently closed and not accepting new candidates.'}
            </p>
            <p className="text-sm text-gray-500">
              Please contact the HR team if you have any questions.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 to-amber-50 flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-8">
        <h1 className="text-2xl font-bold mb-1">Start Interview</h1>
        <p className="text-gray-600 mb-6">Interview ID: {interviewId}</p>
        
        {/* Pre-Interview Rules & Instructions */}
        <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg text-sm">
          <h2 className="font-bold text-blue-900 mb-3">✅ Pre-Interview Requirements & Instructions</h2>
          <div className="space-y-2 text-blue-800">
            <div>
              <span className="font-semibold">🔐 Identity Verification (Mandatory):</span>
              <p className="ml-4">Your webcam will capture your photo for identity confirmation.</p>
            </div>
            <div>
              <span className="font-semibold">🖥️ Screen Sharing (Mandatory):</span>
              <p className="ml-4">You must share your entire screen — single-window sharing is not allowed. If full screen is not shared, the interview will not start.</p>
            </div>
            <div>
              <span className="font-semibold">🎤 Camera & Audio Requirements:</span>
              <ul className="ml-4 list-disc list-inside">
                <li>Keep your face clearly visible and stay centered in the frame</li>
                <li>Enable microphone and speaker audio</li>
                <li>Do not mute your system audio — the AI interviewer voice must be audible</li>
              </ul>
            </div>
            <div>
              <span className="font-semibold">🚫 Activity Monitoring:</span>
              <p className="ml-4">Do not switch tabs/windows during the interview. Any screen switching or suspicious activity will trigger a cheating alert and may end the interview.</p>
            </div>
            <div>
              <span className="font-semibold">📌 Interview Environment Rules:</span>
              <ul className="ml-4 list-disc list-inside">
                <li>Ensure stable internet and good lighting</li>
                <li>Sit in a quiet place without interruptions</li>
                <li>Maintain eye contact and respond naturally</li>
              </ul>
            </div>
            <p className="mt-3 font-semibold text-blue-900">Your cooperation helps us ensure a fair and secure interview experience.</p>
            <p className="mt-2 text-xs text-blue-700">Click "Start Interview" only after agreeing to these conditions.</p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Name</label>
            <input 
              value={name} 
              onChange={e => setName(e.target.value)} 
              className="w-full px-4 py-3 border border-gray-300 rounded-lg" 
              placeholder="Your name" 
            />
          </div>
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">Email</label>
            <input 
              value={email} 
              onChange={e => setEmail(e.target.value)} 
              className="w-full px-4 py-3 border border-gray-300 rounded-lg" 
              placeholder="you@example.com" 
            />
          </div>

          {/* Camera Photo Capture Section */}
          <div className="border rounded-lg p-4 bg-gray-50">
            <div className="flex items-center justify-between mb-3">
              <span className="font-semibold text-gray-700">Camera Photo *</span>
              {photoUploaded ? (
                <span className="text-green-600 text-sm font-medium">✓ Uploaded</span>
              ) : null}
            </div>
            {!cameraStream && !capturedBlob && !photoUploaded && (
              <button 
                onClick={startCamera} 
                className="w-full bg-gray-200 hover:bg-gray-300 text-gray-800 py-2 rounded font-medium transition"
              >
                Enable Camera
              </button>
            )}
            {cameraStream && !capturedBlob && (
              <div className="space-y-2">
                <video 
                  ref={videoRef} 
                  className="w-full rounded border border-gray-300 bg-gray-100" 
                  autoPlay 
                  playsInline 
                  muted
                  style={{ minHeight: '200px', objectFit: 'cover' }}
                />
                <div className="flex gap-2">
                  <button 
                    onClick={capturePhoto} 
                    disabled={!cameraReady}
                    className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-2 rounded font-medium transition disabled:bg-gray-300"
                  >
                    Capture
                  </button>
                  <button 
                    onClick={() => {
                      cameraStream.getTracks().forEach(t => t.stop());
                      setCameraStream(null);
                      setCameraReady(false);
                    }} 
                    className="px-4 bg-gray-200 hover:bg-gray-300 text-gray-800 rounded font-medium transition"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
            {capturedBlob && !photoUploaded && (
              <div className="space-y-2">
                <img 
                  src={URL.createObjectURL(capturedBlob)} 
                  alt="Preview" 
                  className="w-full rounded border border-gray-300" 
                />
                <div className="flex gap-2">
                  <button 
                    onClick={() => {
                      setCapturedBlob(null);
                      URL.revokeObjectURL(URL.createObjectURL(capturedBlob));
                    }} 
                    className="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-800 py-2 rounded font-medium transition"
                  >
                    Retake
                  </button>
                  <button 
                    disabled={uploadingPhoto || !responseId} 
                    onClick={uploadPhoto} 
                    className="flex-1 bg-orange-600 text-white py-2 rounded hover:bg-orange-700 disabled:bg-gray-300 font-medium transition"
                  >
                    {uploadingPhoto ? 'Uploading...' : 'Upload Photo'}
                  </button>
                </div>
                {!responseId && (
                  <p className="text-xs text-gray-500 mt-1">
                    Photo will be uploaded when you start the interview
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Screen Recording Permission Section */}
          <div className="border rounded-lg p-4 bg-gray-50">
            <div className="flex items-center justify-between mb-3">
              <span className="font-semibold text-gray-700">Screen Recording Permission *</span>
              {screenPermissionGranted ? (
                <span className="text-green-600 text-sm font-medium">✓ Granted</span>
              ) : null}
            </div>
            {!screenPermissionGranted && (
              <button 
                onClick={requestScreenPermission} 
                className="w-full bg-gray-200 hover:bg-gray-300 text-gray-800 py-2 rounded font-medium transition"
              >
                Grant Screen Access
              </button>
            )}
            {screenPermissionGranted && (
              <div className="text-sm text-gray-600">
                Screen access granted. Recording will start automatically when the interview begins.
              </div>
            )}
          </div>

          {accessError && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
              {accessError}
            </div>
          )}
          
          <button 
            onClick={handleStart} 
            disabled={
              !name.trim() || 
              !email.trim() || 
              loadingStatus || 
              !capturedBlob || 
              !screenPermissionGranted
            }
            className="w-full bg-orange-600 text-white py-3 rounded-lg font-semibold hover:bg-orange-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition"
          >
            {loadingStatus ? 'Starting...' : 'Start Interview'}
          </button>
        </div>
      </div>
    </div>
  );
}


