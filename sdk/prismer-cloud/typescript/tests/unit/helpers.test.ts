/**
 * Unit tests for pure helper functions: safeSlug() and guessMimeType()
 */

import { describe, it, expect } from 'vitest';
import { safeSlug, guessMimeType } from '../../src/index';

// ============================================================================
// safeSlug
// ============================================================================

describe('safeSlug', () => {
  it('should pass through a normal slug unchanged', () => {
    expect(safeSlug('my-cool-skill')).toBe('my-cool-skill');
  });

  it('should pass through alphanumeric slugs', () => {
    expect(safeSlug('skill123')).toBe('skill123');
  });

  it('should sanitize path traversal (../../etc/passwd)', () => {
    const result = safeSlug('../../etc/passwd');
    expect(result).not.toContain('..');
    expect(result).not.toContain('/');
    expect(result).toBe('etcpasswd');
  });

  it('should remove null bytes', () => {
    expect(safeSlug('my\0skill')).toBe('myskill');
  });

  it('should remove forward slashes', () => {
    expect(safeSlug('path/to/skill')).toBe('pathtoskill');
  });

  it('should remove backslashes', () => {
    expect(safeSlug('path\\to\\skill')).toBe('pathtoskill');
  });

  it('should handle empty string', () => {
    expect(safeSlug('')).toBe('');
  });

  it('should preserve unicode characters', () => {
    expect(safeSlug('skill-name')).toBe('skill-name');
  });

  it('should preserve CJK characters', () => {
    expect(safeSlug('skill-test')).toBe('skill-test');
  });

  it('should handle a slug that is only dots', () => {
    expect(safeSlug('..')).toBe('');
  });

  it('should handle multiple consecutive path traversals', () => {
    const result = safeSlug('../../../../root');
    expect(result).not.toContain('..');
    expect(result).not.toContain('/');
    expect(result).toBe('root');
  });

  it('should handle mixed slashes and dots', () => {
    const result = safeSlug('../foo/..\\bar\\..baz');
    expect(result).not.toContain('/');
    expect(result).not.toContain('\\');
    expect(result).toBe('foobarbaz');
  });

  it('should handle slug with only slashes', () => {
    expect(safeSlug('///')).toBe('');
  });

  it('should handle slug with only backslashes', () => {
    expect(safeSlug('\\\\\\')).toBe('');
  });

  it('should preserve hyphens and underscores', () => {
    expect(safeSlug('my_skill-v2')).toBe('my_skill-v2');
  });

  it('should preserve dots that are not part of ..', () => {
    expect(safeSlug('v1.2.3')).toBe('v1.2.3');
  });
});

// ============================================================================
// guessMimeType
// ============================================================================

describe('guessMimeType', () => {
  // Image types
  it('should map .png to image/png', () => {
    expect(guessMimeType('photo.png')).toBe('image/png');
  });

  it('should map .jpg to image/jpeg', () => {
    expect(guessMimeType('photo.jpg')).toBe('image/jpeg');
  });

  it('should map .jpeg to image/jpeg', () => {
    expect(guessMimeType('photo.jpeg')).toBe('image/jpeg');
  });

  it('should map .gif to image/gif', () => {
    expect(guessMimeType('anim.gif')).toBe('image/gif');
  });

  it('should map .webp to image/webp', () => {
    expect(guessMimeType('image.webp')).toBe('image/webp');
  });

  it('should map .svg to image/svg+xml', () => {
    expect(guessMimeType('icon.svg')).toBe('image/svg+xml');
  });

  it('should map .ico to image/x-icon', () => {
    expect(guessMimeType('favicon.ico')).toBe('image/x-icon');
  });

  it('should map .bmp to image/bmp', () => {
    expect(guessMimeType('legacy.bmp')).toBe('image/bmp');
  });

  // Document types
  it('should map .pdf to application/pdf', () => {
    expect(guessMimeType('report.pdf')).toBe('application/pdf');
  });

  it('should map .doc to application/msword', () => {
    expect(guessMimeType('letter.doc')).toBe('application/msword');
  });

  it('should map .docx to openxmlformats word type', () => {
    expect(guessMimeType('letter.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('should map .xls to application/vnd.ms-excel', () => {
    expect(guessMimeType('data.xls')).toBe('application/vnd.ms-excel');
  });

  it('should map .xlsx to openxmlformats spreadsheet type', () => {
    expect(guessMimeType('data.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('should map .ppt to application/vnd.ms-powerpoint', () => {
    expect(guessMimeType('slides.ppt')).toBe('application/vnd.ms-powerpoint');
  });

  it('should map .pptx to openxmlformats presentation type', () => {
    expect(guessMimeType('slides.pptx')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
  });

  // Text types
  it('should map .txt to text/plain', () => {
    expect(guessMimeType('readme.txt')).toBe('text/plain');
  });

  it('should map .csv to text/csv', () => {
    expect(guessMimeType('export.csv')).toBe('text/csv');
  });

  it('should map .html to text/html', () => {
    expect(guessMimeType('page.html')).toBe('text/html');
  });

  it('should map .css to text/css', () => {
    expect(guessMimeType('styles.css')).toBe('text/css');
  });

  it('should map .js to text/javascript', () => {
    expect(guessMimeType('app.js')).toBe('text/javascript');
  });

  it('should map .md to text/markdown', () => {
    expect(guessMimeType('README.md')).toBe('text/markdown');
  });

  // Data types
  it('should map .json to application/json', () => {
    expect(guessMimeType('config.json')).toBe('application/json');
  });

  it('should map .xml to application/xml', () => {
    expect(guessMimeType('feed.xml')).toBe('application/xml');
  });

  it('should map .yaml to text/yaml', () => {
    expect(guessMimeType('config.yaml')).toBe('text/yaml');
  });

  it('should map .yml to text/yaml', () => {
    expect(guessMimeType('config.yml')).toBe('text/yaml');
  });

  // Archive types
  it('should map .zip to application/zip', () => {
    expect(guessMimeType('archive.zip')).toBe('application/zip');
  });

  it('should map .gz to application/gzip', () => {
    expect(guessMimeType('backup.gz')).toBe('application/gzip');
  });

  it('should map .tar to application/x-tar', () => {
    expect(guessMimeType('release.tar')).toBe('application/x-tar');
  });

  // Media types
  it('should map .mp3 to audio/mpeg', () => {
    expect(guessMimeType('song.mp3')).toBe('audio/mpeg');
  });

  it('should map .wav to audio/wav', () => {
    expect(guessMimeType('sound.wav')).toBe('audio/wav');
  });

  it('should map .mp4 to video/mp4', () => {
    expect(guessMimeType('video.mp4')).toBe('video/mp4');
  });

  it('should map .webm to video/webm', () => {
    expect(guessMimeType('clip.webm')).toBe('video/webm');
  });

  // Edge cases
  it('should return application/octet-stream for unknown extension', () => {
    expect(guessMimeType('file.xyz')).toBe('application/octet-stream');
  });

  it('should return application/octet-stream for no extension', () => {
    expect(guessMimeType('Makefile')).toBe('application/octet-stream');
  });

  it('should return application/octet-stream for empty string', () => {
    expect(guessMimeType('')).toBe('application/octet-stream');
  });

  it('should be case insensitive for .PDF', () => {
    expect(guessMimeType('REPORT.PDF')).toBe('application/pdf');
  });

  it('should be case insensitive for .Png', () => {
    expect(guessMimeType('image.Png')).toBe('image/png');
  });

  it('should be case insensitive for .JPG', () => {
    expect(guessMimeType('photo.JPG')).toBe('image/jpeg');
  });

  it('should handle files with multiple dots', () => {
    expect(guessMimeType('archive.tar.gz')).toBe('application/gzip');
  });

  it('should handle dotfiles (hidden files)', () => {
    expect(guessMimeType('.gitignore')).toBe('application/octet-stream');
  });

  it('should handle path-like filenames', () => {
    expect(guessMimeType('path/to/file.pdf')).toBe('application/pdf');
  });
});
