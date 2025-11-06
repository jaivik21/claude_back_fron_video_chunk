import boto3
from botocore.exceptions import ClientError
from config_loader import load_config
from pathlib import Path
from uuid import uuid4
from typing import Optional
import shutil
import subprocess
import os

class StorageService :
    def __init__(self) :
        self.config = load_config()  
        self.storage_type = self.config.get('storage', {}).get('storage_type', 'local')

        if self.storage_type == 's3':
            # Ensure consistent attribute names used below
            self.s3_client = boto3.client('s3')
            self.bucket_name = self.config.get('storage', {}).get('bucket_name')
        else:
            # Resolve storage path with safe defaults
            storage_path_str = (
                self.config.get('storage', {}).get('storage_path')
                or os.getenv('STORAGE_PATH')
            )
            if storage_path_str:
                self.base_path = Path(storage_path_str)
            else:
                # Default to <backend>/storage when not configured
                project_root = Path(__file__).resolve().parents[2]
                self.base_path = project_root / 'storage'
            # Prepare directories
            self.image_dir = self.base_path/'images'
            self.video_dir = self.base_path/'videos'
            self.temp_dir = self.base_path/'temp'
            self.image_dir.mkdir(parents=True, exist_ok=True)
            self.video_dir.mkdir(parents=True, exist_ok=True)
            self.temp_dir.mkdir(parents=True, exist_ok=True)
    
    async def save_candidate_image(self, file_content:bytes, response_id:str, file_extension:str) -> str :
        if self.storage_type == "s3" :
            key = f"images/{response_id}.{file_extension}"
            self.s3_client.put_object(
                Bucket=self.bucket_name,
                Key=key,
                Body=file_content,
                ContentType=f"image/{file_extension}"
            )
            return key
        else :
            filename = f"{response_id}.{file_extension}"
            file_path = self.image_dir / filename
            with open(file_path, "wb") as f:
                f.write(file_content)
            return f"images/{filename}"

    async def save_candidate_video(self, response_id: str) -> str:
        temp_response_dir = self.temp_dir / response_id
        if not temp_response_dir.exists():
            raise FileNotFoundError(f"No chunks found for response_id: {response_id}")
        self.video_dir.mkdir(parents=True, exist_ok=True)
        # Collect available chunks (mp4 primary, fallback to webm if any exist)
        chunk_files = list(sorted(temp_response_dir.glob("*.mp4")))
        # Include any .webm chunks as well (some browsers may still produce webm data)
        chunk_files += list(sorted(temp_response_dir.glob("*.webm")))
        if not chunk_files:
            raise FileNotFoundError(f"No video chunks found for response_id: {response_id}")

        # Output filename is MP4
        filename = self.video_dir / f"{response_id}.mp4"

        print(f"[DEBUG] Re-encoding and concatenating {len(chunk_files)} chunks into MP4")
        # Build FFmpeg command with multiple inputs and a concat filter (re-encode to MP4)
        cmd: list[str] = ["ffmpeg"]
        for chunk_file in chunk_files:
            cmd.extend(["-fflags", "+genpts", "-i", str(chunk_file.absolute())])

        # Build filter_complex: [0:v][0:a][1:v][1:a]...concat=n=N:v=1:a=1[outv][outa]
        filter_parts = []
        for i in range(len(chunk_files)):
            filter_parts.append(f"[{i}:v]")
            filter_parts.append(f"[{i}:a]")
        filter_complex = "".join(filter_parts) + f"concat=n={len(chunk_files)}:v=1:a=1[outv][outa]"

        cmd.extend([
            "-filter_complex", filter_complex,
            "-map", "[outv]",
            "-map", "[outa]",
            "-c:v", "libx264",
            "-preset", "fast",
            "-crf", "23",
            "-c:a", "aac",
            "-b:a", "128k",
            "-movflags", "+faststart",
            "-y",
            str(filename)
        ])
        
        try:
            result = subprocess.run(cmd, check=True, capture_output=True, text=True)
            print(f"[DEBUG] FFmpeg merge completed successfully")
        except subprocess.CalledProcessError as e:
            error_msg = e.stderr if isinstance(e.stderr, str) else e.stderr.decode('utf-8', errors='ignore')
            print(f"[ERROR] FFmpeg merge failed: {error_msg}")
            raise RuntimeError(f"FFmpeg merge failed: {error_msg}")

        shutil.rmtree(temp_response_dir, ignore_errors=True)
        
        if self.storage_type == "s3" :
            key = f"videos/{response_id}.mp4"
            with open(filename, "rb") as f:
                self.s3_client.put_object(
                    Bucket=self.bucket_name,
                    Key=key,
                    Body=f.read(),
                    ContentType=f"video/mp4"
                )
            # Clean up local file after S3 upload
            filename.unlink(missing_ok=True)
            return key
        else :       
            return str(filename)
    
    async def save_chunk(self, file_content:bytes, response_id:str, file_extension:str) -> str :
        if self.storage_type == "s3" :
            key = f"chunks/{response_id}/{uuid4()}.{file_extension}"
            self.s3_client.put_object(
                Bucket=self.bucket_name,
                Key=key,
                Body=file_content,
                ContentType=f"videos/{file_extension}"
            )
            return key
        else :
            chunk_dir = self.temp_dir / response_id
            chunk_dir.mkdir(parents=True, exist_ok=True)
            file_path = chunk_dir / f"{uuid4()}.{file_extension}"
            with open(file_path, "wb") as f:
                f.write(file_content)
            return str(file_path)

storage_service = StorageService()