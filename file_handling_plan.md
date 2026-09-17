# File Handling Strategy Options

## Current State Analysis
The current Electron app handles files in the following ways:
- **Audio Files**: Stored in user-selected directories, referenced by absolute paths in cues
- **Cue Data**: Stored in JSON files (cues.json) with file paths and metadata
- **Configuration**: Stored in appConfig.json in userData directory
- **Workspaces**: Saved as separate JSON files with cue layouts

## Option 1: File System Based (Recommended)
**Approach**: Continue using file system storage with Node.js backend

### Pros:
- ✅ Maintains current workflow and file organization
- ✅ Users can easily backup and share cue files
- ✅ No database setup required
- ✅ Works with existing file management tools
- ✅ Supports large audio libraries efficiently
- ✅ File paths remain human-readable

### Cons:
- ❌ Requires file system access permissions
- ❌ Path management complexity across platforms
- ❌ No built-in file versioning or conflict resolution

### Implementation:
```javascript
// File structure
project/
├── audio/                    # Audio files directory
│   ├── sound1.mp3
│   ├── sound2.wav
│   └── ...
├── cues/                     # Cue data directory
│   ├── workspace1.json
│   ├── workspace2.json
│   └── ...
└── config/
    └── appConfig.json
```

### File Management Features:
- **Audio File Organization**: 
  - User-selectable audio directory
  - Automatic file copying/moving on import
  - File validation and format checking
- **Cue Data Storage**:
  - JSON-based cue storage
  - Workspace management
  - Automatic backup creation
- **Path Resolution**:
  - Relative paths for portability
  - Absolute path fallback
  - Cross-platform path handling

---

## Option 2: Database + File Storage Hybrid
**Approach**: SQLite database for metadata, file system for audio files

### Pros:
- ✅ Better querying and searching capabilities
- ✅ Structured data relationships
- ✅ Built-in data integrity
- ✅ Easier backup of metadata
- ✅ Better performance for large cue libraries

### Cons:
- ❌ Additional complexity
- ❌ Database migration required
- ❌ Less portable than JSON files
- ❌ Requires database management

### Implementation:
```sql
-- Database schema
CREATE TABLE cues (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    file_path TEXT,
    metadata TEXT, -- JSON blob
    created_at DATETIME,
    updated_at DATETIME
);

CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    layout TEXT, -- JSON blob
    created_at DATETIME
);
```

---

## Option 3: Cloud Storage Integration
**Approach**: Store files in cloud storage (AWS S3, Google Drive, etc.)

### Pros:
- ✅ Automatic backup and sync
- ✅ Access from multiple devices
- ✅ No local storage limitations
- ✅ Built-in versioning

### Cons:
- ❌ Requires internet connection
- ❌ Additional costs
- ❌ Privacy concerns
- ❌ Complex authentication
- ❌ Latency for audio playback

### Implementation:
- Use cloud storage APIs
- Cache frequently used files locally
- Implement offline mode with local fallback

---

## Option 4: Embedded File Storage
**Approach**: Store audio files as binary data in database

### Pros:
- ✅ Single file deployment
- ✅ No file system dependencies
- ✅ Atomic operations
- ✅ Built-in backup

### Cons:
- ❌ Database bloat
- ❌ Poor performance for large files
- ❌ Difficult to manage audio files externally
- ❌ Memory usage issues

---

## Recommended Implementation: Option 1 (File System Based)

### File Structure:
```
accompaniment-data/
├── audio/                    # User's audio files
│   ├── imported/            # Files imported by the app
│   └── user/                # User's original files
├── cues/                    # Cue data
│   ├── workspaces/          # Workspace files
│   ├── backups/             # Automatic backups
│   └── templates/           # Cue templates
├── config/                  # Configuration
│   ├── appConfig.json
│   └── userPreferences.json
└── temp/                    # Temporary files
    └── waveforms/           # Generated waveform data
```

### Key Features:

#### 1. Audio File Management
```javascript
class AudioFileManager {
    // Import audio files
    async importAudioFile(filePath, options = {}) {
        // Copy to audio directory
        // Generate metadata
        // Create waveform data
        // Return relative path for cues
    }
    
    // Validate audio files
    validateAudioFile(filePath) {
        // Check format support
        // Verify file integrity
        // Extract metadata
    }
    
    // Organize files
    organizeAudioFiles(strategy = 'flat') {
        // Flat: all files in one directory
        // Folders: organize by type/date
        // Custom: user-defined organization
    }
}
```

#### 2. Cue Data Management
```javascript
class CueDataManager {
    // Save workspace
    async saveWorkspace(workspaceData, name) {
        // Save to JSON file
        // Create backup
        // Update recent workspaces
    }
    
    // Load workspace
    async loadWorkspace(workspacePath) {
        // Load JSON data
        // Validate file paths
        // Update UI
    }
    
    // Export/Import
    async exportWorkspace(workspaceId, format = 'json') {
        // Export with relative paths
        // Include audio files if requested
        // Create portable package
    }
}
```

#### 3. Path Resolution
```javascript
class PathManager {
    // Convert absolute paths to relative
    toRelativePath(absolutePath, basePath) {
        // Handle cross-platform paths
        // Create portable references
    }
    
    // Resolve relative paths to absolute
    resolvePath(relativePath, basePath) {
        // Handle missing files
        // Provide fallback options
    }
    
    // Validate file existence
    validateFilePaths(cueData) {
        // Check all referenced files
        // Report missing files
        // Suggest alternatives
    }
}
```

### Migration Strategy:
1. **Phase 1**: Set up new file structure
2. **Phase 2**: Implement file import/export
3. **Phase 3**: Migrate existing data
4. **Phase 4**: Add advanced features (backup, sync, etc.)

### User Experience:
- **File Import**: Drag & drop with automatic organization
- **Workspace Management**: Save/load with file validation
- **Backup**: Automatic backups with user control
- **Portability**: Export workspaces with audio files
- **Recovery**: Restore from backups or re-link files

---

## Decision Required
Please review these options and indicate your preference. The recommended approach (Option 1) maintains the current workflow while adding modern file management features. However, if you have specific requirements or preferences, we can adapt the implementation accordingly.

**Questions to consider:**
1. Do you want to maintain the current file-based approach?
2. Are there specific file organization requirements?
3. Do you need cloud sync capabilities?
4. What's the expected size of audio libraries?
5. Are there backup/restore requirements?
