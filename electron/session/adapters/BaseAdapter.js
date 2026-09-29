/**
 * Session adapter contract — capabilities() drives UI enable/disable (no fake options).
 */
class BaseAdapter {
  constructor() {
    this.id = 'base';
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
