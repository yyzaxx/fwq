import json, os, re, stat, sys, zipfile
source, target = sys.argv[1:3]
try:
    files, skipped, total = [], [], 0
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries) > 2000:
            raise ValueError('压缩包文件过多，请分批上传')
        candidates = []
        for entry in entries:
            name = entry.filename.replace('\\', '/')
            parts = name.split('/')
            if name.startswith('/') or re.match(r'^[A-Za-z]:', name) or '..' in parts or '\x00' in name:
                raise ValueError('压缩包包含不安全路径，请重新打包')
            mode = entry.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise ValueError('压缩包包含符号链接，请重新打包')
            if entry.flag_bits & 1:
                raise ValueError('不支持加密压缩包，请移除密码')
            if entry.is_dir():
                continue
            if any(p.startswith('.') or p == '__MACOSX' for p in parts):
                skipped.append({'name': name, 'reason': '系统或隐藏文件'})
                continue
            if os.path.splitext(name)[1].lower() not in ('.png', '.jpg', '.jpeg', '.webp'):
                skipped.append({'name': name, 'reason': '不是支持的图片格式'})
                continue
            candidates.append((entry, name))
        if len(candidates) > 100:
            raise ValueError('每批最多100张图片，请拆分压缩包')
        for index, (entry, name) in enumerate(candidates):
            if entry.file_size > 15 * 1024 * 1024:
                skipped.append({'name': name, 'reason': '单张图片超过15MB'})
                continue
            total += entry.file_size
            if total > 300 * 1024 * 1024:
                raise ValueError('图片解压后总大小超过300MB，请分批上传')
            filename = 'source-%03d.bin' % index
            destination = os.path.join(target, filename)
            try:
                with archive.open(entry) as reader, open(destination, 'xb') as writer:
                    size = 0
                    while True:
                        chunk = reader.read(1024 * 1024)
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > 15 * 1024 * 1024 or size > entry.file_size:
                            raise ValueError('图片解压大小不符合声明')
                        writer.write(chunk)
                files.append({'name': name, 'source': filename})
            except Exception:
                if os.path.exists(destination):
                    os.remove(destination)
                skipped.append({'name': name, 'reason': '图片数据损坏或校验失败'})
    print(json.dumps({'files': files, 'skipped': skipped}, ensure_ascii=False))
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
