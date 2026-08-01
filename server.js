const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'autogestao.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const UPLOADS_DIR = path.join(path.dirname(DB_PATH), 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOADS_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Apenas imagens sao permitidas'));
  }
});

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    senha_hash TEXT NOT NULL,
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessoes (
    token TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    expira_em TEXT NOT NULL,
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS socios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, tel TEXT, cpf TEXT, email TEXT,
    pct_padrao REAL DEFAULT 50, obs TEXT,
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS veiculos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, placa TEXT, ano INTEGER, data_compra TEXT,
    valor_compra REAL NOT NULL, tem_socio TEXT DEFAULT 'nao',
    socio_id INTEGER REFERENCES socios(id), socio_pct REAL DEFAULT 50,
    status TEXT DEFAULT 'Disponivel', data_venda TEXT,
    valor_venda REAL DEFAULT 0, troca REAL DEFAULT 0, obs TEXT,
    data_entrada TEXT DEFAULT (date('now')),
    material_pronto INTEGER DEFAULT 0,
    data_gravacao TEXT,
    fipe_valor REAL,
    fipe_atualizado_em TEXT,
    tipo_aquisicao TEXT DEFAULT 'compra',
    consignante_nome TEXT,
    consignante_contato TEXT,
    valor_minimo_dono REAL,
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS custos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
    descricao TEXT NOT NULL, valor REAL NOT NULL,
    pago_por TEXT DEFAULT 'eu', data TEXT,
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS veiculo_fotos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
    arquivo TEXT NOT NULL,
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS veiculos_auditoria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    veiculo_id INTEGER NOT NULL,
    usuario_id INTEGER REFERENCES usuarios(id),
    acao TEXT NOT NULL,
    dados_antes TEXT,
    dados_depois TEXT,
    criado_em TEXT DEFAULT (datetime('now'))
  );
`);

// migração leve: colunas de consignação/alerta se o banco já existia sem elas
for (const col of [
  "ALTER TABLE veiculos ADD COLUMN tipo_aquisicao TEXT DEFAULT 'compra'",
  "ALTER TABLE veiculos ADD COLUMN consignante_nome TEXT",
  "ALTER TABLE veiculos ADD COLUMN consignante_contato TEXT",
  "ALTER TABLE veiculos ADD COLUMN valor_minimo_dono REAL",
  "ALTER TABLE veiculos ADD COLUMN data_entrada TEXT",
  "ALTER TABLE veiculos ADD COLUMN material_pronto INTEGER DEFAULT 0",
  "ALTER TABLE veiculos ADD COLUMN data_gravacao TEXT",
]) {
  try { db.exec(col); } catch (e) { /* coluna já existe, ignora */ }
}

const ok  = (res, data) => res.json({ ok: true, data });
const err = (res, msg, s = 400) => res.status(s).json({ ok: false, error: msg });

function saveCustos(vid, arr) {
  db.prepare('DELETE FROM custos WHERE veiculo_id=?').run(vid);
  const ins = db.prepare('INSERT INTO custos (veiculo_id,descricao,valor,pago_por,data) VALUES (?,?,?,?,?)');
  for (const c of (arr || [])) {
    if (c.descricao && Number(c.valor) > 0)
      ins.run(vid, c.descricao, c.valor, c.pago_por || 'eu', c.data || '');
  }
}

// ---------- AUTH ----------
function requireAuth(req, res, next) {
  const token = req.cookies.sessao;
  if (!token) return err(res, 'Nao autenticado', 401);
  const sess = db.prepare('SELECT * FROM sessoes WHERE token=?').get(token);
  if (!sess || new Date(sess.expira_em) < new Date()) return err(res, 'Sessao expirada', 401);
  const user = db.prepare('SELECT id, nome, email FROM usuarios WHERE id=?').get(sess.usuario_id);
  if (!user) return err(res, 'Usuario nao encontrado', 401);
  req.user = user;
  next();
}

app.post('/api/auth/registrar', (req, res) => {
  const { nome, email, senha } = req.body;
  if (!nome || !email || !senha) return err(res, 'Nome, email e senha obrigatorios');
  if (senha.length < 6) return err(res, 'Senha precisa de ao menos 6 caracteres');

  const totalUsuarios = db.prepare('SELECT COUNT(*) as n FROM usuarios').get().n;
  if (totalUsuarios > 0) {
    const token = req.cookies.sessao;
    const sess = token && db.prepare('SELECT * FROM sessoes WHERE token=?').get(token);
    const logado = sess && new Date(sess.expira_em) >= new Date();
    if (!logado) return err(res, 'Cadastro fechado. Peça para quem já tem acesso te cadastrar.', 403);
  }

  const existe = db.prepare('SELECT id FROM usuarios WHERE email=?').get(email.toLowerCase());
  if (existe) return err(res, 'Email ja cadastrado');
  const hash = bcrypt.hashSync(senha, 10);
  const r = db.prepare('INSERT INTO usuarios (nome, email, senha_hash) VALUES (?,?,?)')
    .run(nome, email.toLowerCase(), hash);
  ok(res, { id: r.lastInsertRowid, nome, email: email.toLowerCase() });
});

app.post('/api/auth/login', (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return err(res, 'Email e senha obrigatorios');
  const user = db.prepare('SELECT * FROM usuarios WHERE email=?').get(email.toLowerCase());
  if (!user || !bcrypt.compareSync(senha, user.senha_hash)) return err(res, 'Credenciais invalidas', 401);
  const token = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessoes (token, usuario_id, expira_em) VALUES (?,?,?)').run(token, user.id, expira);
  res.cookie('sessao', token, { httpOnly: true, maxAge: 30 * 24 * 3600 * 1000, sameSite: 'lax' });
  ok(res, { id: user.id, nome: user.nome, email: user.email });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessoes WHERE token=?').run(req.cookies.sessao);
  res.clearCookie('sessao');
  ok(res, { msg: 'Deslogado' });
});

app.get('/api/auth/me', requireAuth, (req, res) => ok(res, req.user));

// tudo abaixo exige login
app.use('/api', requireAuth);

// ---------- SOCIOS ----------
app.get('/api/socios', (_, res) => ok(res, db.prepare('SELECT * FROM socios ORDER BY nome').all()));
app.post('/api/socios', (req, res) => {
  const { nome, tel, cpf, email, pct_padrao, obs } = req.body;
  if (!nome) return err(res, 'Nome obrigatorio');
  const r = db.prepare('INSERT INTO socios (nome,tel,cpf,email,pct_padrao,obs) VALUES (?,?,?,?,?,?)')
    .run(nome, tel||'', cpf||'', email||'', pct_padrao ?? 50, obs||'');
  ok(res, db.prepare('SELECT * FROM socios WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/socios/:id', (req, res) => {
  const { nome, tel, cpf, email, pct_padrao, obs } = req.body;
  if (!nome) return err(res, 'Nome obrigatorio');
  db.prepare('UPDATE socios SET nome=?,tel=?,cpf=?,email=?,pct_padrao=?,obs=? WHERE id=?')
    .run(nome, tel||'', cpf||'', email||'', pct_padrao ?? 50, obs||'', req.params.id);
  ok(res, db.prepare('SELECT * FROM socios WHERE id=?').get(req.params.id));
});
app.delete('/api/socios/:id', (req, res) => {
  if (db.prepare('SELECT id FROM veiculos WHERE socio_id=? LIMIT 1').get(req.params.id))
    return err(res, 'Socio vinculado a veiculos.');
  db.prepare('DELETE FROM socios WHERE id=?').run(req.params.id);
  ok(res, { id: req.params.id });
});

// ---------- VEICULOS ----------
app.get('/api/veiculos', (_, res) => {
  const veiculos = db.prepare('SELECT * FROM veiculos ORDER BY criado_em DESC').all();
  const hoje = new Date();
  const comCalculos = veiculos.map(v => {
    const dias_desde_gravacao = v.data_gravacao
      ? Math.floor((hoje - new Date(v.data_gravacao)) / 86400000) : null;
    return {
      ...v,
      dias_desde_gravacao,
      alerta_material: v.material_pronto === 1 && dias_desde_gravacao !== null
        && dias_desde_gravacao >= 15 && v.status !== 'Vendido'
    };
  });
  ok(res, comCalculos);
});

app.post('/api/veiculos', (req, res) => {
  const b = req.body;
  const consig = b.tipo_aquisicao === 'consignacao';
  if (!b.nome) return err(res, 'Nome obrigatorio');
  if (!consig && !b.valor_compra) return err(res, 'Valor de compra obrigatorio');
  if (consig && !b.consignante_nome) return err(res, 'Nome do consignante obrigatorio');
  if (consig && !b.valor_minimo_dono) return err(res, 'Valor minimo combinado com o dono obrigatorio');
  const r = db.prepare(`INSERT INTO veiculos
    (nome,placa,ano,data_compra,valor_compra,tem_socio,socio_id,socio_pct,status,data_venda,valor_venda,troca,obs,data_entrada,material_pronto,data_gravacao,tipo_aquisicao,consignante_nome,consignante_contato,valor_minimo_dono)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.nome, b.placa||'', b.ano||null, b.data_compra||'', consig ? 0 : b.valor_compra, b.tem_socio||'nao',
         b.socio_id||null, b.socio_pct ?? 50, b.status||'Disponivel', b.data_venda||'', b.valor_venda||0,
         b.troca||0, b.obs||'', b.data_entrada || new Date().toISOString().slice(0,10),
         b.material_pronto ? 1 : 0, b.data_gravacao||null, b.tipo_aquisicao||'compra',
         b.consignante_nome||null, b.consignante_contato||null, consig ? b.valor_minimo_dono : null);
  saveCustos(r.lastInsertRowid, b.custos);
  const novo = db.prepare('SELECT * FROM veiculos WHERE id=?').get(r.lastInsertRowid);
  db.prepare('INSERT INTO veiculos_auditoria (veiculo_id,usuario_id,acao,dados_depois) VALUES (?,?,?,?)')
    .run(r.lastInsertRowid, req.user.id, 'criado', JSON.stringify(novo));
  ok(res, novo);
});

app.put('/api/veiculos/:id', (req, res) => {
  const b = req.body;
  const consig = b.tipo_aquisicao === 'consignacao';
  const antes = db.prepare('SELECT * FROM veiculos WHERE id=?').get(req.params.id);
  if (!antes) return err(res, 'Veiculo nao encontrado', 404);
  if (!b.nome) return err(res, 'Nome obrigatorio');
  if (!consig && !b.valor_compra) return err(res, 'Valor de compra obrigatorio');
  if (consig && !b.consignante_nome) return err(res, 'Nome do consignante obrigatorio');
  if (consig && !b.valor_minimo_dono) return err(res, 'Valor minimo combinado com o dono obrigatorio');
  db.prepare(`UPDATE veiculos SET nome=?,placa=?,ano=?,data_compra=?,valor_compra=?,tem_socio=?,socio_id=?,socio_pct=?,
    status=?,data_venda=?,valor_venda=?,troca=?,obs=?,data_entrada=?,material_pronto=?,data_gravacao=?,
    tipo_aquisicao=?,consignante_nome=?,consignante_contato=?,valor_minimo_dono=? WHERE id=?`)
    .run(b.nome, b.placa||'', b.ano||null, b.data_compra||'', consig ? 0 : b.valor_compra, b.tem_socio||'nao',
         b.socio_id||null, b.socio_pct ?? 50, b.status||'Disponivel', b.data_venda||'', b.valor_venda||0,
         b.troca||0, b.obs||'', b.data_entrada||null, b.material_pronto ? 1 : 0, b.data_gravacao||null,
         b.tipo_aquisicao||'compra', b.consignante_nome||null, b.consignante_contato||null,
         consig ? b.valor_minimo_dono : null, req.params.id);
  if (b.custos !== undefined) saveCustos(req.params.id, b.custos);
  const depois = db.prepare('SELECT * FROM veiculos WHERE id=?').get(req.params.id);
  db.prepare('INSERT INTO veiculos_auditoria (veiculo_id,usuario_id,acao,dados_antes,dados_depois) VALUES (?,?,?,?,?)')
    .run(req.params.id, req.user.id, 'editado', JSON.stringify(antes), JSON.stringify(depois));
  ok(res, depois);
});

app.delete('/api/veiculos/:id', (req, res) => {
  const antes = db.prepare('SELECT * FROM veiculos WHERE id=?').get(req.params.id);
  if (!antes) return err(res, 'Veiculo nao encontrado', 404);
  const fotos = db.prepare('SELECT arquivo FROM veiculo_fotos WHERE veiculo_id=?').all(req.params.id);
  for (const f of fotos) { try { fs.unlinkSync(path.join(UPLOADS_DIR, f.arquivo)); } catch (e) {} }
  db.prepare('DELETE FROM veiculos WHERE id=?').run(req.params.id);
  db.prepare('INSERT INTO veiculos_auditoria (veiculo_id,usuario_id,acao,dados_antes) VALUES (?,?,?,?)')
    .run(req.params.id, req.user.id, 'excluido', JSON.stringify(antes));
  ok(res, { id: req.params.id });
});

app.get('/api/veiculos/:id/historico', (req, res) => {
  ok(res, db.prepare(`
    SELECT h.*, u.nome as usuario_nome FROM veiculos_auditoria h
    LEFT JOIN usuarios u ON u.id = h.usuario_id
    WHERE h.veiculo_id=? ORDER BY h.criado_em DESC
  `).all(req.params.id));
});

// ---------- FOTOS ----------
app.get('/api/veiculos/:id/fotos', (req, res) => {
  ok(res, db.prepare('SELECT * FROM veiculo_fotos WHERE veiculo_id=? ORDER BY criado_em').all(req.params.id));
});

app.post('/api/veiculos/:id/fotos', (req, res) => {
  upload.array('fotos', 10)(req, res, (uerr) => {
    if (uerr) return err(res, uerr.message);
    const veiculo = db.prepare('SELECT id FROM veiculos WHERE id=?').get(req.params.id);
    if (!veiculo) return err(res, 'Veiculo nao encontrado', 404);
    const ins = db.prepare('INSERT INTO veiculo_fotos (veiculo_id, arquivo) VALUES (?,?)');
    const salvas = (req.files || []).map(f => {
      const r = ins.run(req.params.id, f.filename);
      return { id: r.lastInsertRowid, veiculo_id: parseInt(req.params.id), arquivo: f.filename };
    });
    ok(res, salvas);
  });
});

app.delete('/api/fotos/:id', (req, res) => {
  const foto = db.prepare('SELECT * FROM veiculo_fotos WHERE id=?').get(req.params.id);
  if (!foto) return err(res, 'Foto nao encontrada', 404);
  try { fs.unlinkSync(path.join(UPLOADS_DIR, foto.arquivo)); } catch (e) {}
  db.prepare('DELETE FROM veiculo_fotos WHERE id=?').run(req.params.id);
  ok(res, { id: req.params.id });
});

// ---------- FIPE (proxy pra API publica parallelum/fipe v2) ----------
const FIPE_BASE = 'https://fipe.parallelum.com.br/api/v2';
async function fipeGet(pathSuffix) {
  const r = await fetch(FIPE_BASE + pathSuffix);
  if (!r.ok) throw new Error('FIPE indisponivel (' + r.status + ')');
  return r.json();
}
app.get('/api/fipe/marcas', async (_, res) => {
  try { ok(res, await fipeGet('/cars/brands')); }
  catch (e) { err(res, e.message, 502); }
});
app.get('/api/fipe/modelos/:marcaId', async (req, res) => {
  try { ok(res, await fipeGet(`/cars/brands/${req.params.marcaId}/models`)); }
  catch (e) { err(res, e.message, 502); }
});
app.get('/api/fipe/anos/:marcaId/:modeloId', async (req, res) => {
  try { ok(res, await fipeGet(`/cars/brands/${req.params.marcaId}/models/${req.params.modeloId}/years`)); }
  catch (e) { err(res, e.message, 502); }
});
app.get('/api/fipe/valor/:marcaId/:modeloId/:anoId', async (req, res) => {
  try { ok(res, await fipeGet(`/cars/brands/${req.params.marcaId}/models/${req.params.modeloId}/years/${req.params.anoId}`)); }
  catch (e) { err(res, e.message, 502); }
});
app.put('/api/veiculos/:id/fipe', (req, res) => {
  const { fipe_valor } = req.body;
  if (!fipe_valor) return err(res, 'fipe_valor obrigatorio');
  db.prepare('UPDATE veiculos SET fipe_valor=?, fipe_atualizado_em=? WHERE id=?')
    .run(fipe_valor, new Date().toISOString(), req.params.id);
  ok(res, db.prepare('SELECT * FROM veiculos WHERE id=?').get(req.params.id));
});

// ---------- CUSTOS ----------
app.get('/api/custos', (_, res) => ok(res, db.prepare('SELECT * FROM custos ORDER BY veiculo_id, criado_em').all()));

// ---------- ALERTAS ----------
app.get('/api/alertas', (_, res) => {
  const veiculos = db.prepare("SELECT * FROM veiculos WHERE status != 'Vendido' AND material_pronto = 1").all();
  const hoje = new Date();
  const alertas = veiculos
    .filter(v => v.data_gravacao)
    .map(v => ({ ...v, dias: Math.floor((hoje - new Date(v.data_gravacao)) / 86400000) }))
    .filter(v => v.dias >= 15);
  ok(res, alertas);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AutoGestao rodando na porta ${PORT}`));
