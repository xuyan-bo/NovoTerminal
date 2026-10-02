/**
 * Session adapter contract — capabilities() drives UI enable/disable (no fake options).
 */
const path = require('path');

function binaryStem(p) {
  return path.basename(String(p || '')).toLowerCase().replace(/\.(exe|bat|cmd)$/i, '');
}

class BaseAdapter {
  constructor() {
    this.id = 'base';
    this.candidates = [];
  }

  /** 候选可执行文件归一化名称集合，用于校验用户手动选择的文件是否为目标客户端 */
  binaryStems() {
    return this.candidates.map(binaryStem);
  }

  matchesBinary(filePath) {
    const stem = binaryStem(filePath);
    return stem !== '' && this.binaryStems().includes(stem);
  }

  /** @returns {{embeddable:boolean,resolution:string,colorDepth:boolean,refreshRate:boolean,multimon:string,clipboard:boolean,processTracked:boolean}} */
  capabilities() {
    return {
      embeddable: false,
      resolution: 'none',
      colorDepth: false,
      refreshRate: false,
      multimon: 'none',
      clipboard: false,
      processTracked: false,
    };
  }

  async testConnection() {
    return { ok: false, error: 'not implemented' };
  }

  async connect() {
    throw new Error('connect not implemented');
  }

  async disconnect() {
    throw new Error('disconnect not implemented');
  }
}

module.exports = { BaseAdapter };
