import { io, Socket } from 'socket.io-client';
import { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Send, CheckCircle, Loader2, Volume2, Clock } from 'lucide-react';
import { getApiHeaders } from '../utils/api';

interface InterviewSessionProps {
  interviewId: string;
  candidateName: string;
  candidateEmail: string;
  apiBaseUrl: string;
  screenPermissionGranted?: boolean;
  existingScreenStream?: MediaStream | null;
}

export default function InterviewSession({
  interviewId,
  candidateName,
  candidateEmail,
  apiBaseUrl,
  screenPermissionGranted = false,
  existingScreenStream = null,
}: InterviewSessionProps) {
  const [responseId, setResponseId] = useState<string | null>(null);
  const [currentQuestion, setCurrentQuestion] = useState<string>('');
  const [questionNumber, setQuestionNumber] = useState(0);
  const [totalQuestions, setTotalQuestions] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [partialTranscript, setPartialTranscript] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [interviewComplete, setInterviewComplete] = useState(false);
  const [finalAnalysis, setFinalAnalysis] = useState<any>(null);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null); // Time remaining in seconds

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Screen recording refs
  const screenRecorderRef = useRef<MediaRecorder | null>(null);
  const screenChunksRef = useRef<Blob[]>([]);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenChunkIndexRef = useRef<number>(0);
  
  // Security monitoring refs
  const tabSwitchCountRef = useRef<number>(0);
  const cheatingAlertsRef = useRef<Array<{ type: string; timestamp: number; details?: string }>>([]);
  const lastScreenActivityRef = useRef<number>(Date.now());
  const screenCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  
  // Camera preview refs
  const [cameraPreviewStream, setCameraPreviewStream] = useState<MediaStream | null>(null);
  const cameraPreviewRef = useRef<HTMLVideoElement | null>(null);
  const [screenSharingStopped, setScreenSharingStopped] = useState(false);
  
  // Track if we've already initialized to prevent re-running
  const sessionInitializedRef = useRef(false);

  useEffect(() => {
    // Prevent re-initialization if already initialized
    if (sessionInitializedRef.current) {
      return;
    }
    
    let cancelled = false;
    const startSession = async () => {
      setLoading(true);
      try {
        const response = await fetch(`${apiBaseUrl}/api/interview/start-interview`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            interview_id: interviewId,
            candidate_name: candidateName,
            candidate_email: candidateEmail,
          }),
        });

        if (cancelled) return;

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ detail: 'Failed to start interview' }));
          throw new Error(errorData.detail || 'Failed to start interview');
        }

        const data = await response.json();
        if (cancelled) return;
        
        // Mark as initialized to prevent re-running
        sessionInitializedRef.current = true;
        
        setResponseId(data.response_id);
        
        if (data.duration_minutes && data.duration_minutes > 0) {
          const totalSeconds = data.duration_minutes * 60;
          setTimeRemaining(totalSeconds);
        }

        {
          const socket = io(apiBaseUrl.replace('/api', ''), {
            transports: ['websocket'],
          });

          socket.on('connect', () => {
            console.log('[DEBUG] Socket.IO connected');
            setSocketConnected(true);
            socket.emit('start_interview', {
              interview_id: interviewId,
              response_id: data.response_id,
            }, (response: any) => {
              if (response && response.ok) {
                console.log('[DEBUG] Interview session started:', response);
              } else {
                console.error('[ERROR] Failed to start interview session:', response);
              }
            });
          });

          socket.on('disconnect', () => setSocketConnected(false));

          socket.on('partial_transcript', (msg: { text: string; is_final?: boolean }) => {
            if (cancelled) return;
            const text = msg?.text || '';
            const isFinal = !!msg?.is_final;
            if (isFinal) {
              setTranscript((prev) => (prev ? prev + ' ' : '') + text);
              setPartialTranscript('');
            } else {
              setPartialTranscript(text);
            }
          });

          socket.on('transcript_result', (msg: { text: string; is_final?: boolean }) => {
            if (cancelled) return;
            setTranscript((prev) => (prev ? prev + ' ' : '') + (msg?.text || ''));
            setPartialTranscript('');
          });

          socketRef.current = socket;

          if (data.response_id && !cancelled) {
            fetchCurrentQuestion(data.response_id);
          }
        }

        // Start camera preview for candidate
        if (!cancelled) {
          try {
            const cameraStream = await navigator.mediaDevices.getUserMedia({ 
              video: { facingMode: 'user' }, 
              audio: false 
            });
            if (!cancelled) {
              setCameraPreviewStream(cameraStream);
            } else {
              cameraStream.getTracks().forEach(track => track.stop());
            }
          } catch (e) {
            console.warn('Camera preview not available:', e);
            // Camera preview is optional, don't block interview
          }
        }

        // Start screen recording after session begins (if permission was granted)
        // Use existingScreenStream from props (captured in closure) - only check once
        if (!cancelled && screenPermissionGranted && data.response_id) {
          try {
            console.log('[DEBUG] Starting screen recording with existingScreenStream:', {
              hasStream: !!existingScreenStream,
              videoTracks: existingScreenStream?.getVideoTracks().length || 0,
              audioTracks: existingScreenStream?.getAudioTracks().length || 0
            });
            // Only start if not already recording
            if (!screenRecorderRef.current || screenRecorderRef.current.state === 'inactive') {
              await startScreenRecording(data.response_id, existingScreenStream);
            } else {
              console.log('[DEBUG] Screen recording already active, skipping');
            }
          } catch (e) {
            const errorMessage = e instanceof Error ? e.message : 'Failed to start screen recording';
            console.error('[ERROR] Failed to start screen recording:', e);
            console.error('[ERROR] Error details:', {
              message: errorMessage,
              hasExistingStream: !!existingScreenStream,
              screenPermissionGranted
            });
            if (!cancelled) {
              // Only set error if it's not about validation - validation errors should be handled gracefully
              if (!errorMessage.includes('Full screen sharing') && !errorMessage.includes('enable audio')) {
                setError(errorMessage);
              } else {
                // For validation errors, just log - don't block the interview
                console.warn('[WARN] Screen sharing validation issue:', errorMessage);
              }
            }
            // Don't block interview if screen recording fails, but show error
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'An error occurred');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    startSession();
    
    // Cleanup on unmount
    return () => {
      cancelled = true;
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
      // Cleanup screen recording
      if (screenRecorderRef.current && screenRecorderRef.current.state !== 'inactive') {
        screenRecorderRef.current.stop();
      }
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach(track => track.stop());
        screenStreamRef.current = null;
      }
      // Cleanup camera preview
      if (cameraPreviewStream) {
        cameraPreviewStream.getTracks().forEach(track => track.stop());
      }
    };
    
    // Only run once on mount - dependencies removed to prevent re-initialization
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Timer countdown effect
  useEffect(() => {
    if (timeRemaining === null || timeRemaining <= 0 || interviewComplete) {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      // Auto-end interview when time runs out
      if (timeRemaining === 0 && !interviewComplete && responseId) {
        endInterviewManually();
      }
      return;
    }

    // Start timer countdown
    timerIntervalRef.current = setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev === null || prev <= 1) {
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }
    };
  }, [timeRemaining, interviewComplete, responseId]);


  const fetchCurrentQuestion = async (resId: string, abortSignal?: AbortSignal) => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/interview/get-current-question?response_id=${encodeURIComponent(resId)}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: abortSignal
      });

      if (abortSignal?.aborted) return;

      if (!response.ok) {
        throw new Error('Failed to fetch question');
      }

      const data = await response.json();
      
      if (abortSignal?.aborted) return;
      
      console.log('[DEBUG] Question response:', { 
        has_tts: !!data.tts_audio_base64, 
        tts_size: data.tts_audio_base64 ? data.tts_audio_base64.length : 0,
        question: data.current_question 
      });

      if (data.complete === true || data.interview_complete === true) {
        setInterviewComplete(true);
      } else {
        const questionText = typeof data.current_question === 'string'
          ? data.current_question
          : data.current_question?.question || data.current_question?.text || '';

        setCurrentQuestion(questionText);
        setQuestionNumber(data.question_number || 0);
        setTotalQuestions(data.total_questions || 0);

        if (data.tts_audio_base64) {
          console.log('[DEBUG] Playing TTS audio, base64 length:', data.tts_audio_base64.length);
          playTTSAudio(data.tts_audio_base64);
        } else {
          console.warn('[WARN] No TTS audio in response');
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      console.error('[ERROR] Failed to fetch question:', err);
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  const playTTSAudio = (base64Audio: string) => {
    try {
      console.log('[DEBUG] Decoding TTS audio, base64 length:', base64Audio.length);
      const audioData = atob(base64Audio);
      console.log('[DEBUG] Decoded audio data length:', audioData.length);
      
      const arrayBuffer = new ArrayBuffer(audioData.length);
      const view = new Uint8Array(arrayBuffer);
      for (let i = 0; i < audioData.length; i++) {
        view[i] = audioData.charCodeAt(i);
      }

      const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
      const audioUrl = URL.createObjectURL(blob);
      console.log('[DEBUG] Created audio blob URL:', audioUrl);

      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }

      const audio = new Audio(audioUrl);
      audioRef.current = audio;

      audio.onplay = () => {
        console.log('[DEBUG] Audio started playing');
        setIsPlayingAudio(true);
      };
      audio.onended = () => {
        console.log('[DEBUG] Audio finished playing');
        setIsPlayingAudio(false);
        URL.revokeObjectURL(audioUrl);
      };
      audio.onerror = (e) => {
        console.error('[ERROR] Audio playback error:', e);
        setIsPlayingAudio(false);
        URL.revokeObjectURL(audioUrl);
      };
      audio.onloadstart = () => console.log('[DEBUG] Audio loading started');
      audio.oncanplay = () => console.log('[DEBUG] Audio can play');

      console.log('[DEBUG] Attempting to play audio...');
      audio.play().catch(err => {
        console.error('[ERROR] Error playing TTS audio:', err);
        setIsPlayingAudio(false);
      });
    } catch (err) {
      console.error('[ERROR] Error processing TTS audio:', err);
    }
  };

  const replayQuestion = () => {
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play();
    }
  };

  // Update camera preview video element - use ref to prevent re-renders
  const cameraStreamRef = useRef<MediaStream | null>(null);
  
  useEffect(() => {
    if (!cameraPreviewRef.current) return;
    
    const video = cameraPreviewRef.current;
    
    // Only update if stream actually changed
    if (cameraPreviewStream !== cameraStreamRef.current) {
      cameraStreamRef.current = cameraPreviewStream;
      
      if (cameraPreviewStream) {
        video.srcObject = cameraPreviewStream;
        video.playsInline = true;
        video.muted = true;
        video.autoplay = true;
        video.play().catch(() => {
          // Silently fail - autoplay might be blocked
        });
      } else {
        video.srcObject = null;
      }
    }
  }, [cameraPreviewStream]);

  const startScreenRecording = async (resId: string, useExistingStream?: MediaStream | null) => {
    try {
      // Don't start if already recording
      if (screenRecorderRef.current && screenRecorderRef.current.state !== 'inactive') {
        console.log('[DEBUG] Screen recording already active, skipping start');
        return;
      }
      
      let displayStream: MediaStream | null = null;
      
      // Use existing stream if provided (from CandidateStart), otherwise request new one
      if (useExistingStream && useExistingStream.getVideoTracks().length > 0) {
        const existingTrack = useExistingStream.getVideoTracks()[0];
        const existingAudioTracks = useExistingStream.getAudioTracks();
        const settings = existingTrack.getSettings();
        const displaySurface = (settings as any).displaySurface;
        
        console.log(`[DEBUG] Checking existing screen sharing stream:`, {
          readyState: existingTrack.readyState,
          enabled: existingTrack.enabled,
          displaySurface: displaySurface,
          audioTracks: existingAudioTracks.length,
          videoTracks: useExistingStream.getVideoTracks().length
        });
        
        // Ensure the existing track is enabled and active
        if (!existingTrack.enabled) {
          existingTrack.enabled = true;
        }
        
        // Only reject if track is explicitly ended - otherwise accept it
        // The stream was already validated in CandidateStart, so trust it
        if (existingTrack.readyState === 'ended') {
          console.warn('[DEBUG] Existing stream track has ended, requesting new stream...');
          displayStream = null; // Will trigger new stream request below
        } else {
          // Stream is good, use it - don't re-validate since CandidateStart already did
          // Also check if it's the same stream we're already using (compare by first track ID)
          if (screenStreamRef.current && screenStreamRef.current.getVideoTracks().length > 0) {
            const currentTrackId = screenStreamRef.current.getVideoTracks()[0].id;
            const existingTrackId = existingTrack.id;
            if (currentTrackId === existingTrackId) {
              console.log('[DEBUG] Already using this stream, skipping re-initialization');
              return; // Exit early, we're already recording with this stream
            }
          }
          console.log('[DEBUG] Using existing stream without re-validation');
          displayStream = useExistingStream;
        }
      }
      
      if (!displayStream) {
        // Only request new stream if we don't already have an active recording
        if (screenRecorderRef.current && screenRecorderRef.current.state !== 'inactive') {
          console.log('[DEBUG] Screen recording already active, not requesting new stream');
          return;
        }
        
        console.log('[DEBUG] Requesting new screen sharing stream...');
        const newStream = await (navigator.mediaDevices as any).getDisplayMedia({ 
          video: { displaySurface: 'monitor' },
          audio: true 
        });

        // Validate full screen sharing (reject window/tab-only)
        const videoTrack = newStream.getVideoTracks()[0];
        const settings = videoTrack.getSettings();
        const displaySurface = (settings as any).displaySurface;
        
        console.log(`[DEBUG] New stream validation: displaySurface=${displaySurface}, audioTracks=${newStream.getAudioTracks().length}`);
        
        // Only reject if we're CERTAIN it's not full screen (displaySurface exists and is NOT 'monitor')
        // If displaySurface is undefined, it might just be a browser limitation, so accept it
        if (displaySurface !== undefined && displaySurface !== 'monitor') {
          newStream.getTracks().forEach((track: MediaStreamTrack) => track.stop());
          throw new Error('Full screen sharing is required. Please select "Entire Screen" instead of a single window or tab.');
        }

        // Validate that audio is enabled during screen sharing
        // Note: Some browsers might not expose audio tracks immediately, so warn but don't reject
        const audioTracks = newStream.getAudioTracks();
        if (audioTracks.length === 0) {
          console.warn('[DEBUG] No audio tracks found in new stream - this might be a browser limitation');
          // Don't reject - audio might be available but not exposed as a track
          // We'll still try to get mic audio separately
        }
        
        displayStream = newStream;
        console.log('[DEBUG] New stream accepted');
      }
      
      // At this point, displayStream is guaranteed to be non-null
      if (!displayStream) {
        throw new Error('Failed to obtain screen sharing stream');
      }

      // Get microphone audio and mix into the final stream
      let finalStream: MediaStream = displayStream as MediaStream;
      
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        const tracks: MediaStreamTrack[] = [];
        tracks.push(...displayStream.getVideoTracks());
        
        // Prefer mic over display audio to ensure voice is captured
        const audioTracks = [
          ...mic.getAudioTracks(),
          ...displayStream.getAudioTracks(),
        ];
        
        // Deduplicate by track ID
        const uniqueAudio = new Map<string, MediaStreamTrack>();
        audioTracks.forEach(t => uniqueAudio.set(t.id, t));
        tracks.push(...uniqueAudio.values());
        
        finalStream = new MediaStream(tracks);
      } catch (e) {
        // Mic unavailable, proceed with displayStream (may still include tab/system audio)
        finalStream = displayStream as MediaStream;
      }

      screenStreamRef.current = finalStream;

      // Verify stream is active before recording
      const videoTrack = finalStream.getVideoTracks()[0];
      if (!videoTrack) {
        throw new Error('No video track found in screen stream. Please ensure screen sharing is enabled.');
      }
      
      // Check if track is enabled and not ended
      // Note: readyState can be 'live' or 'ended' - we just need it to exist and be enabled
      if (videoTrack.readyState === 'ended') {
        throw new Error('Screen sharing track has ended. Please restart screen sharing.');
      }
      
      if (!videoTrack.enabled) {
        console.warn('[DEBUG] Video track is disabled, enabling it...');
        videoTrack.enabled = true;
      }
      
      // Log detailed stream info for debugging
      const streamSettings = videoTrack.getSettings();
      console.log(`[DEBUG] Stream verified for recording:`, {
        readyState: videoTrack.readyState,
        enabled: videoTrack.enabled,
        trackId: videoTrack.id,
        displaySurface: (streamSettings as any).displaySurface,
        audioTracks: finalStream.getAudioTracks().length,
        videoTracks: finalStream.getVideoTracks().length
      });

      // Handle user stopping sharing via browser UI
      videoTrack.onended = () => {
        console.warn('Screen sharing was stopped by user');
        recordCheatingAlert('screen_sharing_stopped', 'User stopped screen sharing');
        setScreenSharingStopped(true);
        stopScreenRecording(resId);
        setError('⚠️ Screen sharing was stopped! Please restart screen sharing to continue the interview.');
      };

      // Monitor screen activity for black screens/pauses
      startScreenActivityMonitoring();

      // Determine best MIME type (prefer MP4)
      const mime = (() => {
        const mp4Preferred = 'video/mp4;codecs=avc1,mp4a';
        const mp4Fallback = 'video/mp4';
        if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(mp4Preferred)) {
          return mp4Preferred;
        }
        if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(mp4Fallback)) {
          return mp4Fallback;
        }
        // Fallback to webm if mp4 not supported by browser
        return 'video/webm;codecs=vp9,opus';
      })();

      console.log(`[DEBUG] Creating MediaRecorder with mime: ${mime}, stream tracks: video=${finalStream.getVideoTracks().length}, audio=${finalStream.getAudioTracks().length}`);
      const screenRecorder = new MediaRecorder(finalStream, { mimeType: mime });
      console.log(`[DEBUG] MediaRecorder created. State: ${screenRecorder.state}, mimeType: ${screenRecorder.mimeType}`);
      
      screenRecorderRef.current = screenRecorder;
      screenChunksRef.current = [];
      screenChunkIndexRef.current = 0;

      screenRecorder.ondataavailable = async (e: BlobEvent) => {
        console.log(`[DEBUG] ondataavailable fired - data exists: ${!!e.data}, size: ${e.data?.size || 0}, type: ${e.data?.type || 'unknown'}`);
        
        if (e.data && e.data.size > 0) {
          // Check if chunk is too small (likely invalid/empty)
          if (e.data.size < 1000) {
            console.error(`[ERROR] Received suspiciously small chunk: ${e.data.size} bytes. MediaRecorder may not be capturing properly.`);
            console.error(`[ERROR] Stream active tracks: video=${finalStream.getVideoTracks().length}, audio=${finalStream.getAudioTracks().length}`);
            console.error(`[ERROR] Video track readyState: ${finalStream.getVideoTracks()[0]?.readyState}, enabled: ${finalStream.getVideoTracks()[0]?.enabled}`);
          }
          
          screenChunksRef.current.push(e.data);
          console.log(`[DEBUG] Received chunk data: ${e.data.size} bytes, type: ${e.data.type}, total chunks: ${screenChunksRef.current.length}`);
          
          // Send chunk via Socket.IO
          const chunkIndex = screenChunkIndexRef.current;
          try {
            // Log blob details before conversion
            console.log(`[DEBUG] Converting blob to base64 - size: ${e.data.size} bytes, type: ${e.data.type}, chunk index: ${chunkIndex}`);
            
            // Convert blob to base64 using FileReader (more memory efficient for large chunks)
            const base64Chunk = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                try {
                  const result = reader.result as string;
                  console.log(`[DEBUG] FileReader result length: ${result.length}, has comma: ${result.includes(',')}`);
                  
                  // Remove data URL prefix (e.g., "data:video/webm;base64,")
                  let base64 = result;
                  if (result.includes(',')) {
                    base64 = result.split(',')[1];
                    console.log(`[DEBUG] After removing prefix, base64 length: ${base64.length}`);
                  } else {
                    console.warn(`[WARN] No comma found in FileReader result, using entire result`);
                  }
                  
                  // Clean any whitespace, newlines, carriage returns, and other invalid characters
                  // Base64 only allows: A-Z, a-z, 0-9, +, /, and = (for padding)
                  const beforeClean = base64.length;
                  base64 = base64.trim().replace(/[\s\n\r\t]/g, '');
                  
                  // Remove any characters that aren't valid base64 (keep only A-Za-z0-9+/=)
                  base64 = base64.replace(/[^A-Za-z0-9+/=]/g, '');
                  console.log(`[DEBUG] After cleaning - before: ${beforeClean}, after: ${base64.length}`);
                  
                  // Validate base64 string
                  if (base64.length === 0) {
                    throw new Error('Empty base64 string after cleaning');
                  }
                  
                  // Ensure proper padding (base64 strings must be multiples of 4)
                  const padding = base64.length % 4;
                  if (padding > 0) {
                    base64 += '='.repeat(4 - padding);
                  }
                  
                  // Calculate expected decoded size (base64 is ~4/3 the size of binary)
                  const expectedDecodedSize = Math.floor(base64.length * 3 / 4);
                  console.log(`[DEBUG] Base64 string length: ${base64.length}, expected decoded size: ~${expectedDecodedSize} bytes`);
                  
                  if (expectedDecodedSize < 100) {
                    console.warn(`[WARN] Base64 chunk is very small (${expectedDecodedSize} bytes), blob size was ${e.data.size} bytes`);
                  }
                  
                  resolve(base64);
                } catch (err) {
                  reject(err);
                }
              };
              reader.onerror = (error) => {
                console.error(`[ERROR] FileReader error:`, error);
                reject(new Error('Failed to read blob as base64'));
              };
              reader.readAsDataURL(e.data);
            });
            
            // Force MP4-only pipeline
            const fileExtension = 'mp4';
            
            // Send chunk via Socket.IO
            // Wait for socket to be ready if not connected yet (with timeout)
            let socket = socketRef.current;
            if (!socket || !socket.connected) {
              console.log(`[DEBUG] Socket not ready yet, waiting up to 5s for connection...`);
              const waitStart = Date.now();
              const maxWait = 5000; // 5 seconds max wait
              
              while ((!socket || !socket.connected) && (Date.now() - waitStart) < maxWait) {
                await new Promise(resolve => setTimeout(resolve, 100)); // Check every 100ms
                socket = socketRef.current;
              }
            }
            
            if (socket && socket.connected) {
              const savePromise = new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                  socket.off('video_chunk_saved', handler);
                  socket.off('error', errorHandler);
                  reject(new Error('Timeout waiting for video_chunk_saved confirmation'));
                }, 10000); // 10 second timeout
                
                const handler = (response: any) => {
                  if (response && response.ok) {
                    clearTimeout(timeout);
                    socket.off('video_chunk_saved', handler);
                    socket.off('error', errorHandler);
                    resolve();
                  }
                };
                
                const errorHandler = (error: any) => {
                  clearTimeout(timeout);
                  socket.off('video_chunk_saved', handler);
                  socket.off('error', errorHandler);
                  reject(new Error(error.error || 'Failed to save video chunk'));
                };
                
                // Listen for confirmation events
                socket.once('video_chunk_saved', handler);
                socket.once('error', errorHandler);
                
                // Log before sending
                console.log(`[DEBUG] Sending chunk ${chunkIndex} - base64 length: ${base64Chunk.length}, expected bytes: ~${Math.floor(base64Chunk.length * 3 / 4)}`);
                
                // Emit the chunk
                socket.emit('save_video_chunk', {
                  response_id: resId,
                  chunk: base64Chunk,
                  file_extension: fileExtension
                });
              });
              
              await savePromise;
              console.log(`[DEBUG] Sent chunk ${chunkIndex} via Socket.IO (${e.data.size} bytes) for response_id: ${resId}`);
              screenChunkIndexRef.current++;
            } else {
              console.error(`[ERROR] Socket not connected after waiting. Socket exists: ${!!socket}, Connected: ${socket?.connected}`);
              throw new Error('Socket not connected, cannot send video chunk');
            }
          } catch (err) {
            console.error(`[ERROR] Failed to send screen recording chunk ${chunkIndex}:`, err);
            // Continue recording even if chunk upload fails
          }
        } else {
          console.warn('[DEBUG] Received empty or null chunk data');
        }
      };

      screenRecorder.onerror = (event: any) => {
        console.error(`[ERROR] MediaRecorder error:`, event);
        console.error(`[ERROR] Error details:`, event.error);
      };
      
      screenRecorder.onstart = () => {
        console.log(`[DEBUG] MediaRecorder started successfully. State: ${screenRecorder.state}`);
      };
      
      screenRecorder.onstop = async () => {
        console.log(`[DEBUG] Screen recorder stopped. Total chunks collected: ${screenChunksRef.current.length}, chunks uploaded: ${screenChunkIndexRef.current}`);
        
        // MediaRecorder should have fired ondataavailable with final data when stop() was called
        // Wait for any pending chunk uploads to complete
        // Give extra time for the final chunk to be processed
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        const uploadedCount = screenChunkIndexRef.current;
        const totalCollected = screenChunksRef.current.length;
        
        if (uploadedCount === 0) {
          console.error(`[ERROR] No chunks were uploaded! Total chunks collected: ${totalCollected}`);
          console.error(`[ERROR] Socket connected: ${socketRef.current?.connected}, Socket exists: ${!!socketRef.current}`);
        } else if (uploadedCount < totalCollected) {
          console.warn(`[WARN] Only ${uploadedCount}/${totalCollected} chunks were uploaded. Some chunks may be missing.`);
        } else {
          console.log(`[DEBUG] Successfully uploaded ${uploadedCount} chunks. Merge will be triggered when results page loads.`);
        }
      };
      
      // Store resId for use in stopScreenRecording
      (screenRecorder as any)._resId = resId;

      // Start recording and collect chunks every 10 seconds
      // MediaRecorder will fire ondataavailable every 10 seconds AND when stop() is called
      screenRecorder.start(10000);
      console.log(`[DEBUG] Screen recording started for response_id: ${resId}, recorder state: ${screenRecorder.state}, timeslice: 10000ms`);
    } catch (e) {
      console.error('Failed to start screen recording:', e);
      throw e;
    }
  };

  const stopScreenRecording = async (_resId: string) => {
    try {
      const recorder = screenRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        // Request any remaining data before stopping
        try {
          if (recorder.state === 'recording') {
            recorder.requestData();
            // Wait a bit for the data to be available
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } catch (e) {
          console.warn('[DEBUG] Could not request data before stop:', e);
        }
        
        const originalOnStop = recorder.onstop;
        const stopPromise = new Promise<void>((resolve) => {
          recorder.onstop = async () => {
            if (originalOnStop) {
              try {
                await (originalOnStop as any).call(recorder, new Event('stop'));
              } catch (e) {
                console.error('Error in original onstop handler:', e);
              }
            }
            // Note: Video merge is now triggered when results page loads, not here
            // This ensures chunks are fully uploaded before merge
            console.log('[DEBUG] Screen recording stopped. Merge will be triggered when results page loads.');
            resolve();
          };
        });
        recorder.stop();
        await stopPromise;
      }

      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach(track => track.stop());
        screenStreamRef.current = null;
      }
    } catch (e) {
      console.warn('Error stopping screen recording:', e);
    }
  };

  const startRecording = async () => {
    if (!socketRef.current || !socketConnected) {
      setError('Socket not connected. Please wait...');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus'
      });

      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = async (event) => {
        if (event.data.size > 0 && socketRef.current && socketConnected) {
          const arrayBuffer = await event.data.arrayBuffer();
          // Convert ArrayBuffer to Uint8Array for Socket.IO
          const uint8Array = new Uint8Array(arrayBuffer);
          socketRef.current.emit('send_audio_chunk', uint8Array, (response: any) => {
            if (response && !response.ok) {
              console.error('[ERROR] Failed to send audio chunk:', response);
            }
          });
          console.log('[DEBUG] Sent audio chunk to backend, size:', arrayBuffer.byteLength);
        }
      };

      mediaRecorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start(250);
      setIsRecording(true);
      setTranscript('');
      setPartialTranscript('');
    } catch (err) {
      setError('Could not access microphone. Please check permissions.');
      console.error('Error accessing microphone:', err);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  // Removed transcribeAudio(): live transcript arrives via socket 'transcript_result'

  const toggleRecording = () => {
    // Block recording if screen sharing is stopped
    if (screenSharingStopped) {
      setError('⚠️ Cannot record: Screen sharing is required. Please restart screen sharing to continue.');
      return;
    }

    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  // Function to restart screen sharing
  const restartScreenSharing = async () => {
    if (!responseId) return;
    
    try {
      setError('');
      // Pass null to request a new stream (since the old one was stopped)
      await startScreenRecording(responseId, null);
      setScreenSharingStopped(false);
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Failed to restart screen sharing';
      setError(errorMessage);
    }
  };

  const submitAnswer = async () => {
    if (!responseId || !transcript.trim() || transcript === 'Recording...') {
      setError('Please record an answer first');
      return;
    }

    // Block submission if screen sharing is stopped
    if (screenSharingStopped) {
      setError('⚠️ Cannot submit: Screen sharing is required. Please restart screen sharing to continue.');
      return;
    }

    setLoading(true);
    try {
      // Ensure recording is stopped before submitting
      if (isRecording) {
        stopRecording();
      }
      const response = await fetch(`${apiBaseUrl}/api/interview/submit-answer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          response_id: responseId,
          // currentQuestion is a string in this component
          question: typeof currentQuestion === 'string' ? currentQuestion : (currentQuestion as any)?.question || '',
          transcript: transcript,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to submit answer');
      }

      const data = await response.json();

      if (data.complete || data.interview_completed) {
        setInterviewComplete(true);
        if (data.final_analysis) {
        setFinalAnalysis(data.final_analysis);
        }
        // Update question counts when interview completes naturally
        if (data.question_number !== undefined) {
          setQuestionNumber(data.question_number);
        }
        if (data.total_questions !== undefined) {
          setTotalQuestions(data.total_questions);
        }
      } else {
        setTranscript('');
        audioChunksRef.current = [];
        await fetchCurrentQuestion(responseId);
        // Reinitialize live STT streaming for the next question
        try {
          if (socketRef.current && socketConnected) {
            socketRef.current.emit('start_interview', {
              interview_id: interviewId,
              response_id: responseId,
            });
          }
        } catch {}
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  // Format time remaining as MM:SS
  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const endInterviewManually = async () => {
    if (!responseId || interviewComplete) return;

    // Clear timer
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }

    setLoading(true);
    try {
      // Stop screen recording before ending interview
      if (screenRecorderRef.current) {
        await stopScreenRecording(responseId);
      }

      // Signal socket stream end for live STT consolidation/cleanup
      if (socketRef.current) {
        try { socketRef.current.emit('end_interview'); } catch {}
      }
      const response = await fetch(`${apiBaseUrl}/api/interview/end-interview`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          response_id: responseId
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to end interview');
      }

      const endData = await response.json();
      setInterviewComplete(true);
      
      // Update question counts from backend response
      if (endData.questions_answered !== undefined) {
        setQuestionNumber(endData.questions_answered);
      }
      if (endData.total_questions !== undefined) {
        setTotalQuestions(endData.total_questions);
      }
      
      // Fetch final analysis from response detail if needed
      if (responseId) {
        try {
          const detailRes = await fetch(`${apiBaseUrl}/api/interview/get-response?response_id=${encodeURIComponent(responseId)}`, {
            method: 'GET',
            headers: getApiHeaders(false),
          });
          if (detailRes.ok) {
            const detailData = await detailRes.json();
            setFinalAnalysis(detailData.general_summary);
          }
        } catch (e) {
          console.error('Failed to fetch final analysis', e);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  // Tab switch detection and cheating monitoring
  useEffect(() => {
    if (!responseId || interviewComplete) return;

    const handleVisibilityChange = () => {
      if (document.hidden) {
        tabSwitchCountRef.current++;
        recordCheatingAlert('tab_switch', `Tab switched (count: ${tabSwitchCountRef.current})`);
        setError(`⚠️ Warning: You switched tabs. This is being monitored. (Count: ${tabSwitchCountRef.current})`);
        
        // If too many tab switches, end interview
        if (tabSwitchCountRef.current >= 3) {
          setError('Interview terminated: Multiple tab switches detected. This indicates suspicious activity.');
          endInterviewManually();
        }
      } else {
        lastScreenActivityRef.current = Date.now();
      }
    };

    const handleBlur = () => {
      recordCheatingAlert('window_blur', 'Window lost focus');
    };

    const handleFocus = () => {
      lastScreenActivityRef.current = Date.now();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [responseId, interviewComplete]);

  // Screen activity monitoring for black screens/pauses
  const startScreenActivityMonitoring = () => {
    if (screenCheckIntervalRef.current) {
      clearInterval(screenCheckIntervalRef.current);
    }

    screenCheckIntervalRef.current = setInterval(() => {
      if (!screenStreamRef.current || interviewComplete) {
        if (screenCheckIntervalRef.current) {
          clearInterval(screenCheckIntervalRef.current);
          screenCheckIntervalRef.current = null;
        }
        return;
      }

      const videoTrack = screenStreamRef.current.getVideoTracks()[0];
      if (!videoTrack) {
        // Track might have ended - this is handled by the onended handler
        return;
      }
      
      // Only alert if track is ended (not just paused or muted)
      if (videoTrack.readyState === 'ended') {
        recordCheatingAlert('screen_track_inactive', 'Screen track has ended');
        return;
      }

      // Update activity timestamp if track is live
      if (videoTrack.readyState === 'live') {
        lastScreenActivityRef.current = Date.now();
      }

      // Check for screen pause (no activity for extended period)
      const now = Date.now();
      const timeSinceActivity = now - lastScreenActivityRef.current;
      
      if (timeSinceActivity > 30000) { // 30 seconds of inactivity
        recordCheatingAlert('screen_pause', `Screen paused for ${Math.floor(timeSinceActivity / 1000)}s`);
      }
    }, 5000); // Check every 5 seconds
  };

  const recordCheatingAlert = (type: string, details?: string) => {
    cheatingAlertsRef.current.push({
      type,
      timestamp: Date.now(),
      details
    });
    console.warn(`[SECURITY ALERT] ${type}:`, details);
    
    // Optionally send to backend for logging (endpoint may not exist, so we catch errors)
    if (responseId) {
      // Async send - don't block
      fetch(`${apiBaseUrl}/api/interview/record-cheating-alert`, {
        method: 'POST',
        headers: getApiHeaders(false), // Candidate endpoint, no API key needed
        body: JSON.stringify({
          response_id: responseId,
          alert_type: type,
          details: details,
          timestamp: Date.now()
        })
      }).catch(err => {
        // Silently fail - endpoint may not exist
        console.debug('Cheating alert endpoint not available:', err);
      });
    }
  };

  // Stop and upload screen recording when interview completes naturally
  useEffect(() => {
    if (interviewComplete && responseId && screenRecorderRef.current) {
      stopScreenRecording(responseId);
      if (screenCheckIntervalRef.current) {
        clearInterval(screenCheckIntervalRef.current);
        screenCheckIntervalRef.current = null;
      }
    }
  }, [interviewComplete, responseId]);

  if (interviewComplete) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-emerald-50 to-teal-50 flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl shadow-xl max-w-3xl w-full p-8">
          <div className="flex items-center gap-3 mb-8">
            <div className="bg-green-600 p-3 rounded-xl">
              <CheckCircle className="w-8 h-8 text-white" />
            </div>
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Interview Complete!</h1>
              <p className="text-gray-600">Thank you for participating</p>
            </div>
          </div>

          <div className="bg-green-50 border border-green-200 rounded-lg p-6 mb-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-2">Summary</h2>
            <p className="text-gray-700">
              {candidateName}, your interview has been completed successfully.
            </p>
            {totalQuestions > 0 && (
              <p className="text-gray-600 mt-2">
                Questions answered: {questionNumber}/{totalQuestions}
              </p>
            )}
          </div>

          {finalAnalysis && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">Analysis</h2>
              {finalAnalysis.overall_score && (
                <div className="mb-4">
                  <p className="text-gray-700 font-semibold">
                    Overall Score: {finalAnalysis.overall_score}/100
                  </p>
                </div>
              )}
              {finalAnalysis.recommendations && finalAnalysis.recommendations.length > 0 && (
                <div>
                  <p className="text-gray-700 font-semibold mb-2">Recommendations:</p>
                  <ul className="list-disc list-inside space-y-1">
                    {finalAnalysis.recommendations.map((rec: string, idx: number) => (
                      <li key={idx} className="text-gray-600">{rec}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 to-amber-50 flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl shadow-xl max-w-4xl w-full p-8">
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-3xl font-bold text-gray-900">Interview Session</h1>
            <div className="flex items-center gap-4">
              {/* Timer Display */}
              {timeRemaining !== null && timeRemaining >= 0 && (
                <div className={`flex items-center gap-2 px-4 py-2 rounded-full font-semibold ${
                  timeRemaining <= 300 // Less than 5 minutes
                    ? 'bg-red-100 text-red-800 animate-pulse'
                    : timeRemaining <= 600 // Less than 10 minutes
                    ? 'bg-orange-100 text-orange-800'
                    : 'bg-blue-100 text-blue-800'
                }`}>
                  <Clock className="w-5 h-5" />
                  <span>{formatTime(timeRemaining)}</span>
                </div>
              )}
              {totalQuestions > 0 && (
                <span className="bg-blue-100 text-blue-800 px-4 py-2 rounded-full font-semibold">
                  Question {questionNumber}/{totalQuestions}
                </span>
              )}
            </div>
          </div>
          <p className="text-gray-600">Candidate: {candidateName}</p>
        </div>

        {/* Camera Preview */}
        {cameraPreviewStream && (
          <div className="mb-4 flex justify-end">
            <div className="relative w-32 h-24 rounded-lg overflow-hidden border-2 border-gray-300 shadow-lg">
              <video 
                ref={cameraPreviewRef}
                className="w-full h-full object-cover"
                autoPlay
                playsInline
                muted
              />
              <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-50 text-white text-xs px-2 py-1 text-center">
                Your Preview
              </div>
            </div>
          </div>
        )}

        {/* Screen Sharing Stopped Warning */}
        {screenSharingStopped && (
          <div className="mb-6 p-4 bg-red-100 border-2 border-red-500 rounded-lg">
            <div className="flex items-start gap-3">
              <div className="text-red-600 text-2xl">⚠️</div>
              <div className="flex-1">
                <h3 className="font-bold text-red-900 mb-2">Screen Sharing Stopped</h3>
                <p className="text-red-800 mb-3">
                  Screen sharing is required to continue the interview. Please restart screen sharing to proceed.
                </p>
                <button
                  onClick={restartScreenSharing}
                  className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg font-semibold transition"
                >
                  Restart Screen Sharing
                </button>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
            {error}
          </div>
        )}

        <div className="mb-8 p-6 bg-gradient-to-r from-blue-50 to-blue-100 rounded-xl border-l-4 border-blue-600">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <h2 className="text-sm font-semibold text-gray-600 mb-2">CURRENT QUESTION</h2>
              <p className="text-xl text-gray-900 font-medium leading-relaxed">
                {currentQuestion || 'Loading question...'}
              </p>
            </div>
            {audioRef.current && (
              <button
                onClick={replayQuestion}
                disabled={isPlayingAudio}
                className="ml-4 p-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
                title="Replay question"
              >
                <Volume2 className={`w-5 h-5 ${isPlayingAudio ? 'animate-pulse' : ''}`} />
              </button>
            )}
          </div>
          {isPlayingAudio && (
            <p className="text-sm text-blue-600 mt-2 animate-pulse">Playing question audio...</p>
          )}
        </div>

        <div className="mb-6">
          <label className="block text-sm font-semibold text-gray-700 mb-3">
            Your Answer {isRecording && <span className="text-red-600 animate-pulse">(Recording...)</span>}
          </label>
          <div className="relative">
            <textarea
              value={partialTranscript ? `${transcript} ${partialTranscript}`.trim() : transcript}
              onChange={(e) => setTranscript(e.target.value)}
              rows={8}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-transparent transition resize-none"
              placeholder="Click the microphone to start recording your answer or type here..."
              disabled={isRecording}
            />
          </div>
          {isRecording && (
            <p className="mt-2 text-sm text-gray-600">
              Recording in progress... Your voice will be transcribed automatically when you stop.
            </p>
          )}
        </div>

        <div className="flex gap-4">
          <button
            onClick={toggleRecording}
            disabled={loading || screenSharingStopped}
            className={`flex-1 py-4 rounded-lg font-semibold transition shadow-lg hover:shadow-xl flex items-center justify-center gap-2 ${
              isRecording
                ? 'bg-red-600 hover:bg-red-700 text-white animate-pulse'
                : 'bg-orange-600 hover:bg-orange-700 text-white'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {isRecording ? (
              <>
                <MicOff className="w-5 h-5" />
                Stop Recording
              </>
            ) : (
              <>
                <Mic className="w-5 h-5" />
                Start Recording
              </>
            )}
          </button>

          <button
            onClick={submitAnswer}
            disabled={loading || !transcript.trim() || transcript === 'Recording...' || screenSharingStopped}
            className="flex-1 bg-green-600 text-white py-4 rounded-lg font-semibold hover:bg-green-700 transition disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-xl flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                Submitting...
              </>
            ) : (
              <>
                <Send className="w-5 h-5" />
                Submit Answer
              </>
            )}
          </button>

          <button
            onClick={endInterviewManually}
            disabled={loading}
            className="px-6 bg-gray-600 text-white py-4 rounded-lg font-semibold hover:bg-gray-700 transition disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-xl"
          >
            End Interview
          </button>
        </div>

        <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <h3 className="text-sm font-semibold text-gray-700 mb-2">How it works:</h3>
          <ul className="text-sm text-gray-600 space-y-1">
            <li>• The question will be read aloud automatically using text-to-speech</li>
            <li>• Click "Start Recording" to begin recording your answer</li>
            <li>• Speak clearly into your microphone</li>
            <li>• Click "Stop Recording" when finished</li>
            <li>• Your speech will be transcribed using backend STT service</li>
            <li>• Review the transcript and click "Submit Answer" to continue</li>
            <li>• Click the speaker icon to replay the question</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
