// D20: .git is enforced at the PermissionRule layer (seatbelt cannot sub-path deny).

export const FROZEN_FILES = [
  '.gitconfig',
  '.bashrc',
  '.zshrc',
  '.profile',
  '.mcp.json',
  '.npmrc',
  '.pypirc',
];

export const FROZEN_DIRS = [
  '.git',
  '.vscode',
  '.claude',
  '.prismer',
  '.ssh',
  '.aws',
  '.config/gcloud',
];

export const FROZEN_GLOBS = [
  '**/*.pem',
  '**/*.key',
  '**/.env*',
  '**/credentials.*',
];
