#!/opt/buddy2api/.venv/bin/python
"""Read the existing Daily access token; never import or refresh its refresh token."""
import base64,json,os,pwd,sys,time
from pathlib import Path
source=Path('/opt/workbuddy/state/wb_refresh_tokens.json')
selection=Path('/etc/buddy2api-account.json')
def claims(token):
    return json.loads(base64.urlsafe_b64decode(token.split('.')[1]+'==='))
records=json.loads(source.read_text())
selected=json.loads(selection.read_text()).get('uid') if selection.exists() else None
chosen=None
for entry in records.values():
    token=entry.get('access_token','')
    try:
        data=claims(token)
    except Exception:
        continue
    if data.get('exp',0)<time.time()+300 or not data.get('sub'):
        continue
    if selected and data['sub']!=selected:
        continue
    chosen=(token,data);break
if not chosen:
    raise SystemExit('未找到所选账号的有效访问令牌；保留网关原记录')
token,data=chosen
if not selected:
    selection.write_text(json.dumps({'uid':data['sub']}));selection.chmod(0o600)
# Work as the restricted service user before opening its encrypted database.
owner=pwd.getpwnam('buddy2api')
os.environ['CB_GATEWAY_DB_PATH']='/var/lib/buddy2api/gateway.db'
os.environ['PYTHONDONTWRITEBYTECODE']='1'
os.umask(0o077)
os.setgroups([]);os.setgid(owner.pw_gid);os.setuid(owner.pw_uid)
sys.path.insert(0,'/opt/buddy2api')
import database as db
existing=next((a for a in db.list_accounts(provider='workbuddy') if a['uid']==data['sub']),None)
fields={'access_token':token,'expires_at':int(data['exp'])*1000,'refresh_token':'','refresh_expires_at':0,'session_state':data.get('session_state',''),'domain':'www.codebuddy.cn'}
if existing:
    if existing.get('access_token')==token and not existing.get('refresh_token'):
        print('访问令牌未变化，无需同步')
    else:
        db.update_account(existing['id'],{**fields,**({'status':'active'} if existing.get('status')=='expired' else {})});print('已同步所选账号的访问令牌，未触及原签到刷新凭据')
else:
    db.add_account({**fields,'name':'现有WorkBuddy账号','nickname':'现有WorkBuddy账号','uid':data['sub'],'provider':'workbuddy','status':'active'})
    print('已接入1个现有WorkBuddy账号，仅保存访问令牌')
