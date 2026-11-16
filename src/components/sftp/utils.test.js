import { describe, it, expect } from 'vitest';
import {
  transferErrorText,
  formatSize,
  joinRemote,
  parentRemote,
  normalizeRemotePath,
  isAbsLocalPath,
  joinLocal,
  localPathOf,
  parentLocal,
  isTaskFinished,
  sortItems,
  fileIcon,
} from './utils';
import { t } from '../../i18n';

describe('formatSize', () => {
  it('按量级切换单位', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1023)).toBe('1023 B');
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatSize(1024 * 1024 * 1024)).toBe('1.00 GB');
  });

  it('空值与非法值按 0 处理', () => {
    expect(formatSize(null)).toBe('0 B');
    expect(formatSize('abc')).toBe('0 B');
  });
});

describe('joinRemote', () => {
  it('拼接远端路径并去掉目标名尾部分隔符', () => {
    expect(joinRemote('/home', 'file.txt')).toBe('/home/file.txt');
    expect(joinRemote('/home/', 'file.txt')).toBe('/home/file.txt');
    expect(joinRemote('/home', 'dir/')).toBe('/home/dir');
    expect(joinRemote('/C:/Users', 'x')).toBe('/C:/Users/x');
  });

  it('根目录不为盘符补前导斜杠', () => {
    expect(joinRemote('/', 'file.txt')).toBe('/file.txt');
    expect(joinRemote('', 'file.txt')).toBe('/file.txt');
    expect(joinRemote('/', 'C:')).toBe('C:');
    expect(joinRemote('/', 'C:\\')).toBe('C:');
  });

  it('没有名字时停在根目录', () => {
    expect(joinRemote(null, null)).toBe('/');
  });
});

describe('parentRemote', () => {
  it('回到上一级，根目录保持根', () => {
    expect(parentRemote('/home/user')).toBe('/home');
    expect(parentRemote('/a/b/')).toBe('/a');
    expect(parentRemote('/home')).toBe('/');
    expect(parentRemote('/')).toBe('/');
    expect(parentRemote('')).toBe('/');
  });

  it('盘符路径回报盘符自身', () => {
    expect(parentRemote('C:/Users')).toBe('C:');
  });
});

describe('normalizeRemotePath', () => {
  it('去掉 Windows 盘符前的根斜杠', () => {
    expect(normalizeRemotePath('/C:/Users')).toBe('C:/Users');
    expect(normalizeRemotePath('/C:')).toBe('C:');
    expect(normalizeRemotePath('/c:/')).toBe('c:/');
  });

  it('普通路径和非字符串原样返回', () => {
    expect(normalizeRemotePath('/home/user')).toBe('/home/user');
    expect(normalizeRemotePath('C:/Users')).toBe('C:/Users');
    expect(normalizeRemotePath(null)).toBe(null);
  });
});

describe('isAbsLocalPath', () => {
  it('识别 POSIX、盘符与 UNC 绝对路径', () => {
    expect(isAbsLocalPath('/home/user')).toBe(true);
    expect(isAbsLocalPath('C:\\Users')).toBe(true);
    expect(isAbsLocalPath('C:/Users')).toBe(true);
    expect(isAbsLocalPath('\\\\server\\share')).toBe(true);
  });

  it('相对路径与空值不是绝对路径', () => {
    expect(isAbsLocalPath('/')).toBe(false);
    expect(isAbsLocalPath('home/user')).toBe(false);
    expect(isAbsLocalPath('')).toBe(false);
  });
});

describe('joinLocal', () => {
  it('按目录风格选择分隔符', () => {
    expect(joinLocal('/home', 'a.txt')).toBe('/home/a.txt');
    expect(joinLocal('/home/', 'a.txt')).toBe('/home/a.txt');
    expect(joinLocal('C:\\Users', 'a.txt')).toBe('C:\\Users\\a.txt');
    expect(joinLocal('\\\\server\\share', 'a.txt')).toBe('\\\\server\\share\\a.txt');
  });

  it('空目录直接返回名字', () => {
    expect(joinLocal('', 'a.txt')).toBe('a.txt');
  });
});

describe('localPathOf', () => {
  it('盘符行使用自带绝对 path，其余按目录拼接', () => {
    expect(localPathOf('/', { isDrive: true, path: 'C:\\' })).toBe('C:\\');
    expect(localPathOf('/home', { name: 'a.txt' })).toBe('/home/a.txt');
    expect(localPathOf('/home', null)).toBe('');
  });
});

describe('parentLocal', () => {
  it('POSIX 与 Windows 路径都能回到上一级', () => {
    expect(parentLocal('/home/user')).toBe('/home');
    expect(parentLocal('/home/')).toBe('/');
    expect(parentLocal('C:\\Users\\x')).toBe('C:\\Users');
  });

  it('盘符根与根目录保持自身', () => {
    expect(parentLocal('C:')).toBe('C:');
    expect(parentLocal('C:\\')).toBe('C:\\');
    expect(parentLocal('/')).toBe('/');
    expect(parentLocal('')).toBe('');
  });

  it('没有分隔符的相对路径原样返回', () => {
    expect(parentLocal('relative')).toBe('relative');
  });
});

describe('isTaskFinished', () => {
  it('只有终态行算完成', () => {
    ['done', 'error', 'canceled'].forEach((status) => expect(isTaskFinished({ status })).toBe(true));
    ['running', 'pending', 'paused'].forEach((status) => expect(isTaskFinished({ status })).toBe(false));
  });
});

describe('sortItems', () => {
  const make = () => [
    { name: 'b.txt', size: 300, mtimeMs: 3 },
    { name: 'a.txt', size: 100, mtimeMs: 2 },
    { name: 'docs', isDir: true, size: 0, mtimeMs: 1 },
    { name: 'bin', isDir: true, size: 0, mtimeMs: 4 },
    { name: '..', isParent: true },
  ];
  const names = (list) => list.map((x) => x.name);

  it('.. 恒在首位，目录先于文件', () => {
    const out = sortItems(make(), { key: 'name', dir: 'asc' });
    expect(names(out)).toEqual(['..', 'bin', 'docs', 'a.txt', 'b.txt']);
  });

  it('名称降序只影响组内顺序', () => {
    expect(names(sortItems(make(), { key: 'name', dir: 'desc' }))).toEqual(['..', 'docs', 'bin', 'b.txt', 'a.txt']);
  });

  it('按大小排序，同值回落名称', () => {
    expect(names(sortItems(make(), { key: 'size', dir: 'asc' }))).toEqual(['..', 'bin', 'docs', 'a.txt', 'b.txt']);
    expect(names(sortItems(make(), { key: 'size', dir: 'desc' }))).toEqual(['..', 'bin', 'docs', 'b.txt', 'a.txt']);
  });

  it('按原始 mtimeMs 排序', () => {
    expect(names(sortItems(make(), { key: 'time', dir: 'asc' }))).toEqual(['..', 'docs', 'bin', 'a.txt', 'b.txt']);
    expect(names(sortItems(make(), { key: 'time', dir: 'desc' }))).toEqual(['..', 'bin', 'docs', 'b.txt', 'a.txt']);
  });

  it('不改写传入数组', () => {
    const items = make();
    sortItems(items, { key: 'name', dir: 'asc' });
    expect(names(items)).toEqual(['b.txt', 'a.txt', 'docs', 'bin', '..']);
  });

  it('缺省排序按名称升序', () => {
    expect(names(sortItems(make(), undefined))).toEqual(['..', 'bin', 'docs', 'a.txt', 'b.txt']);
  });
});

describe('fileIcon', () => {
  it('按扩展名归类常见类型，大小写不敏感', () => {
    expect(fileIcon('main.go')).toBe('file-code');
    expect(fileIcon('App.VUE')).toBe('file-code');
    expect(fileIcon('deploy.sh')).toBe('file-terminal');
    expect(fileIcon('README.md')).toBe('file-markdown');
    expect(fileIcon('notes.txt')).toBe('file-text');
    expect(fileIcon('tsconfig.json')).toBe('file-json');
    expect(fileIcon('report.pdf')).toBe('file-pdf');
    expect(fileIcon('plan.docx')).toBe('file-word');
    expect(fileIcon('data.csv')).toBe('file-sheet');
    expect(fileIcon('deck.pptx')).toBe('file-slides');
    expect(fileIcon('logo.png')).toBe('file-image');
    expect(fileIcon('voice.m4a')).toBe('file-audio');
    expect(fileIcon('demo.mkv')).toBe('file-video');
    expect(fileIcon('release.tar.gz')).toBe('file-archive');
    expect(fileIcon('schema.sql')).toBe('file-db');
    expect(fileIcon('id_rsa.pub')).toBe('file-key');
    expect(fileIcon('Inter.woff2')).toBe('file-font');
    expect(fileIcon('app.dll')).toBe('file-binary');
    expect(fileIcon('fix.diff')).toBe('file-git');
  });

  it('多段扩展名只看最后一段', () => {
    expect(fileIcon('bundle.tar.gz')).toBe('file-archive');
    expect(fileIcon('component.test.js')).toBe('file-code');
  });

  it('日常非开发类型各有专属图标', () => {
    expect(fileIcon('setup.msi')).toBe('file-package');
    expect(fileIcon('WeChat.apk')).toBe('file-package');
    expect(fileIcon('ubuntu.iso')).toBe('file-disk');
    expect(fileIcon('win11.vhdx')).toBe('file-disk');
    expect(fileIcon('三体.epub')).toBe('file-ebook');
    expect(fileIcon('plan.dwg')).toBe('file-cad');
    expect(fileIcon('model.stl')).toBe('file-model');
    expect(fileIcon('cut.aep')).toBe('file-project');
    expect(fileIcon('letter.eml')).toBe('file-mail');
    expect(fileIcon('桌面快捷方式.lnk')).toBe('file-link');
    expect(fileIcon('mind.xmind')).toBe('file-notes');
  });

  it('图片、字幕、备份与系统文件就近归类', () => {
    expect(fileIcon('IMG_0001.CR2')).toBe('file-image');
    expect(fileIcon('movie.ass')).toBe('file-text');
    expect(fileIcon('mht保存.mhtml')).toBe('file-text');
    expect(fileIcon('backup.bak')).toBe('file-archive');
    expect(fileIcon('ntuser.reg')).toBe('file-config');
    expect(fileIcon('driver.sys')).toBe('file-binary');
    expect(fileIcon('stats.hdf5')).toBe('file-db');
  });

  it('服务器上常见的包与数据文件', () => {
    expect(fileIcon('app.jar')).toBe('file-jar');
    expect(fileIcon('ROOT.war')).toBe('file-jar');
    expect(fileIcon('numpy-2.1.whl')).toBe('file-package');
    expect(fileIcon('rails-7.1.gem')).toBe('file-package');
    expect(fileIcon('serde.crate')).toBe('file-package');
    expect(fileIcon('Newtonsoft.nupkg')).toBe('file-package');
    expect(fileIcon('config.json')).toBe('file-json');
    expect(fileIcon('k8s-deploy.yaml')).toBe('file-yaml');
    expect(fileIcon('docker-compose.yml')).toBe('file-yaml');
    expect(fileIcon('app.toml')).toBe('file-config');
    expect(fileIcon('npm.lock')).toBe('file-text');
    expect(fileIcon('sshd.service')).toBe('file-config');
    expect(fileIcon('app.pid')).toBe('file-text');
  });

  it('同一个后缀两用时的取舍', () => {
    expect(fileIcon('cube.obj')).toBe('file-model');
    expect(fileIcon('disk.vhd')).toBe('file-disk');
    expect(fileIcon('matrix.mm')).toBe('file-notes');
    expect(fileIcon('id.key')).toBe('file-key');
    expect(fileIcon('loader.mts')).toBe('file-code');
    expect(fileIcon('camcorder.m2ts')).toBe('file-video');
  });

  it('按完整文件名识别，dotfile 归为配置', () => {
    expect(fileIcon('Dockerfile')).toBe('file-config');
    expect(fileIcon('Makefile')).toBe('file-terminal');
    expect(fileIcon('.gitignore')).toBe('file-git');
    expect(fileIcon('.bashrc')).toBe('file-terminal');
    expect(fileIcon('.env.local')).toBe('file-config');
    expect(fileIcon('.npmrc')).toBe('file-config');
    expect(fileIcon('LICENSE')).toBe('file-text');
  });

  it('命不中的回落到通用文件图标', () => {
    expect(fileIcon('archive.xyz')).toBe('file');
    expect(fileIcon('README')).toBe('file-text');
    expect(fileIcon('unknown')).toBe('file');
    expect(fileIcon('trailing.')).toBe('file');
    expect(fileIcon('')).toBe('file');
    expect(fileIcon(null)).toBe('file');
  });
});

describe('transferErrorText', () => {
  it('已知错误码取译文，未知码回落原始错误信息', () => {
    expect(transferErrorText({ errorCode: 'ECONNREFUSED' })).toBe(t('err.ECONNREFUSED'));
    expect(transferErrorText({ errorCode: 'NOPE', error: 'disk full' })).toBe('disk full');
  });

  it('没有任何错误信息时用通用失败文案', () => {
    expect(transferErrorText({})).toBe(t('sftp.transferFailed'));
  });
});
