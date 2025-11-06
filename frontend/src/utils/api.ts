// API utility functions for making authenticated requests

const API_KEY = import.meta.env.VITE_API_KEY || '';

export const getApiHeaders = (includeContentType: boolean = true): HeadersInit => {
  const headers: HeadersInit = {};
  
  if (includeContentType) {
    headers['Content-Type'] = 'application/json';
  }
  
  if (API_KEY) {
    headers['API_KEY'] = API_KEY;
    headers['x-api-key'] = API_KEY;
  }
  
  return headers;
};

export const fetchWithAuth = async (
  url: string, 
  options: RequestInit = {}
): Promise<Response> => {
  const headers = {
    ...getApiHeaders(options.method !== 'GET'),
    ...options.headers,
  };
  
  return fetch(url, {
    ...options,
    headers,
  });
};

export const uploadCandidateImage = async (
  apiBaseUrl: string,
  imageBlob: Blob,
  responseId: string,
  filename: string = 'candidate.png'
): Promise<void> => {
  const formData = new FormData();
  formData.append('image', imageBlob, filename);
  formData.append('response_id', responseId);

  const headers = getApiHeaders(false);
  const response = await fetch(`${apiBaseUrl}/api/media/upload-candidate-image`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Failed to upload image' }));
    throw new Error(error.detail || 'Failed to upload candidate image');
  }
};

export const uploadScreenRecordingChunk = async (
  apiBaseUrl: string,
  chunkBlob: Blob,
  responseId: string,
  chunkIndex: number
): Promise<void> => {
  const formData = new FormData();
  formData.append('chunk', chunkBlob, `chunk-${chunkIndex}.webm`);
  formData.append('response_id', responseId);

  const headers = getApiHeaders(false);
  const response = await fetch(`${apiBaseUrl}/api/media/upload-chunk`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Failed to upload chunk' }));
    throw new Error(error.detail || 'Failed to upload recording chunk');
  }
};

export const finalizeScreenRecording = async (
  apiBaseUrl: string,
  responseId: string
): Promise<void> => {
  // Send request to trigger video merge on backend (video file is optional now)
  const formData = new FormData();
  // Create a minimal dummy file - backend will merge chunks regardless
  const dummyBlob = new Blob([''], { type: 'video/webm' });
  formData.append('video', dummyBlob, 'final.webm');
  formData.append('response_id', responseId);

  const headers = getApiHeaders(false);
  const response = await fetch(`${apiBaseUrl}/api/media/upload-candidate-video`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Failed to finalize recording' }));
    throw new Error(error.detail || 'Failed to finalize screen recording');
  }
};

