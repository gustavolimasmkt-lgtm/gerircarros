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
    recovery_code_hash TEXT,
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

  CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT DEFAULT 'cliente',
    nome TEXT NOT NULL,
    telefone TEXT, email TEXT, cpf_cnpj TEXT, endereco TEXT, obs TEXT,
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS checklist_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
    texto TEXT NOT NULL,
    concluido INTEGER DEFAULT 0,
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS parcelas_venda (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
    numero INTEGER NOT NULL,
    valor REAL NOT NULL,
    vencimento TEXT NOT NULL,
    pago INTEGER DEFAULT 0,
    pago_em TEXT,
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS promissorias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    veiculo_id INTEGER REFERENCES veiculos(id) ON DELETE SET NULL,
    cliente_id INTEGER REFERENCES clientes(id),
    cliente_nome_avulso TEXT,
    descricao TEXT,
    valor_total REAL NOT NULL,
    parcelas INTEGER NOT NULL DEFAULT 1,
    data_emissao TEXT,
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS promissoria_parcelas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    promissoria_id INTEGER NOT NULL REFERENCES promissorias(id) ON DELETE CASCADE,
    numero INTEGER NOT NULL,
    valor REAL NOT NULL,
    vencimento TEXT NOT NULL,
    pago INTEGER DEFAULT 0,
    pago_em TEXT
  );
`);

// migração leve: colunas de consignação/alerta se o banco já existia sem elas
for (const col of [
  "ALTER TABLE usuarios ADD COLUMN recovery_code_hash TEXT",
  "ALTER TABLE veiculos ADD COLUMN tipo_aquisicao TEXT DEFAULT 'compra'",
  "ALTER TABLE veiculos ADD COLUMN consignante_nome TEXT",
  "ALTER TABLE veiculos ADD COLUMN consignante_contato TEXT",
  "ALTER TABLE veiculos ADD COLUMN valor_minimo_dono REAL",
  "ALTER TABLE veiculos ADD COLUMN data_entrada TEXT",
  "ALTER TABLE veiculos ADD COLUMN material_pronto INTEGER DEFAULT 0",
  "ALTER TABLE veiculos ADD COLUMN data_gravacao TEXT",
  "ALTER TABLE veiculos ADD COLUMN cor TEXT",
  "ALTER TABLE veiculos ADD COLUMN km INTEGER",
  "ALTER TABLE veiculos ADD COLUMN chassi TEXT",
  "ALTER TABLE veiculos ADD COLUMN preco_pretendido REAL",
  "ALTER TABLE veiculos ADD COLUMN cliente_id INTEGER REFERENCES clientes(id)",
  "ALTER TABLE veiculos ADD COLUMN forma_pagamento TEXT",
  "ALTER TABLE veiculos ADD COLUMN entrada REAL",
  "ALTER TABLE veiculos ADD COLUMN parcelas INTEGER",
  "ALTER TABLE veiculos ADD COLUMN taxa_comissao REAL",
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

function saveParcelas(vid, veiculoRow) {
  db.prepare('DELETE FROM parcelas_venda WHERE veiculo_id=?').run(vid);
  if (veiculoRow.status !== 'Vendido') return;
  const parcelas = veiculoRow.parcelas || 0;
  const valorTotal = (veiculoRow.valor_venda || 0) - (veiculoRow.entrada || 0);
  if (parcelas <= 1 || valorTotal <= 0) return;
  const valorParcela = valorTotal / parcelas;
  const dataBase = veiculoRow.data_venda ? new Date(veiculoRow.data_venda + 'T12:00:00') : new Date();
  const ins = db.prepare('INSERT INTO parcelas_venda (veiculo_id,numero,valor,vencimento) VALUES (?,?,?,?)');
  for (let i = 1; i <= parcelas; i++) {
    const venc = new Date(dataBase);
    venc.setMonth(venc.getMonth() + i);
    ins.run(vid, i, valorParcela, venc.toISOString().slice(0, 10));
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
  const recoveryCode = crypto.randomBytes(6).toString('hex').toUpperCase().match(/.{1,4}/g).join('-'); // ex: A1B2-C3D4-E5F6
  const recoveryHash = bcrypt.hashSync(recoveryCode, 10);
  const r = db.prepare('INSERT INTO usuarios (nome, email, senha_hash, recovery_code_hash) VALUES (?,?,?,?)')
    .run(nome, email.toLowerCase(), hash, recoveryHash);
  ok(res, { id: r.lastInsertRowid, nome, email: email.toLowerCase(), recoveryCode });
});

app.post('/api/auth/recuperar-senha', (req, res) => {
  const { email, codigo, novaSenha } = req.body;
  if (!email || !codigo || !novaSenha) return err(res, 'Email, código de recuperação e nova senha obrigatorios');
  if (novaSenha.length < 6) return err(res, 'Senha precisa de ao menos 6 caracteres');
  const user = db.prepare('SELECT * FROM usuarios WHERE email=?').get(email.toLowerCase());
  if (!user || !user.recovery_code_hash || !bcrypt.compareSync(codigo.trim().toUpperCase(), user.recovery_code_hash))
    return err(res, 'Email ou código de recuperação inválido', 401);
  const novoHash = bcrypt.hashSync(novaSenha, 10);
  const novoCodigo = crypto.randomBytes(6).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');
  const novoCodigoHash = bcrypt.hashSync(novoCodigo, 10);
  db.prepare('UPDATE usuarios SET senha_hash=?, recovery_code_hash=? WHERE id=?').run(novoHash, novoCodigoHash, user.id);
  db.prepare('DELETE FROM sessoes WHERE usuario_id=?').run(user.id); // desloga sessoes antigas por segurança
  ok(res, { msg: 'Senha alterada', novoCodigo });
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

app.post('/api/auth/gerar-codigo-recuperacao', (req, res) => {
  const novoCodigo = crypto.randomBytes(6).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');
  const novoCodigoHash = bcrypt.hashSync(novoCodigo, 10);
  db.prepare('UPDATE usuarios SET recovery_code_hash=? WHERE id=?').run(novoCodigoHash, req.user.id);
  ok(res, { novoCodigo });
});

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
  const veiculos = db.prepare(`
    SELECT v.*, c.nome as cliente_nome, c.telefone as cliente_telefone, c.cpf_cnpj as cliente_cpf_cnpj
    FROM veiculos v LEFT JOIN clientes c ON c.id = v.cliente_id
    ORDER BY v.criado_em DESC
  `).all();
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
  if (b.placa && b.placa.trim()) {
    const dup = db.prepare('SELECT id, nome FROM veiculos WHERE UPPER(REPLACE(placa,"-","")) = UPPER(REPLACE(?,"-",""))').get(b.placa.trim());
    if (dup) return err(res, `Placa já cadastrada no veículo "${dup.nome}" (id ${dup.id}).`);
  }
  const r = db.prepare(`INSERT INTO veiculos
    (nome,placa,ano,data_compra,valor_compra,tem_socio,socio_id,socio_pct,status,data_venda,valor_venda,troca,obs,data_entrada,material_pronto,data_gravacao,tipo_aquisicao,consignante_nome,consignante_contato,valor_minimo_dono,cor,km,chassi,preco_pretendido,cliente_id,forma_pagamento,entrada,parcelas,taxa_comissao)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.nome, b.placa||'', b.ano||null, b.data_compra||'', consig ? 0 : b.valor_compra, b.tem_socio||'nao',
         b.socio_id||null, b.socio_pct ?? 50, b.status||'Disponivel', b.data_venda||'', b.valor_venda||0,
         b.troca||0, b.obs||'', b.data_entrada || new Date().toISOString().slice(0,10),
         b.material_pronto ? 1 : 0, b.data_gravacao||null, b.tipo_aquisicao||'compra',
         b.consignante_nome||null, b.consignante_contato||null, consig ? b.valor_minimo_dono : null,
         b.cor||null, b.km||null, b.chassi||null, b.preco_pretendido||null,
         b.cliente_id||null, b.forma_pagamento||null, b.entrada||null, b.parcelas||null, b.taxa_comissao||null);
  saveCustos(r.lastInsertRowid, b.custos);
  const novo = db.prepare('SELECT * FROM veiculos WHERE id=?').get(r.lastInsertRowid);
  saveParcelas(r.lastInsertRowid, novo);
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
  if (b.placa && b.placa.trim()) {
    const dup = db.prepare('SELECT id, nome FROM veiculos WHERE UPPER(REPLACE(placa,"-","")) = UPPER(REPLACE(?,"-","")) AND id != ?').get(b.placa.trim(), req.params.id);
    if (dup) return err(res, `Placa já cadastrada no veículo "${dup.nome}" (id ${dup.id}).`);
  }
  db.prepare(`UPDATE veiculos SET nome=?,placa=?,ano=?,data_compra=?,valor_compra=?,tem_socio=?,socio_id=?,socio_pct=?,
    status=?,data_venda=?,valor_venda=?,troca=?,obs=?,data_entrada=?,material_pronto=?,data_gravacao=?,
    tipo_aquisicao=?,consignante_nome=?,consignante_contato=?,valor_minimo_dono=?,
    cor=?,km=?,chassi=?,preco_pretendido=?,cliente_id=?,forma_pagamento=?,entrada=?,parcelas=?,taxa_comissao=? WHERE id=?`)
    .run(b.nome, b.placa||'', b.ano||null, b.data_compra||'', consig ? 0 : b.valor_compra, b.tem_socio||'nao',
         b.socio_id||null, b.socio_pct ?? 50, b.status||'Disponivel', b.data_venda||'', b.valor_venda||0,
         b.troca||0, b.obs||'', b.data_entrada||null, b.material_pronto ? 1 : 0, b.data_gravacao||null,
         b.tipo_aquisicao||'compra', b.consignante_nome||null, b.consignante_contato||null,
         consig ? b.valor_minimo_dono : null,
         b.cor||null, b.km||null, b.chassi||null, b.preco_pretendido||null,
         b.cliente_id||null, b.forma_pagamento||null, b.entrada||null, b.parcelas||null, b.taxa_comissao||null,
         req.params.id);
  if (b.custos !== undefined) saveCustos(req.params.id, b.custos);
  const depois = db.prepare('SELECT * FROM veiculos WHERE id=?').get(req.params.id);
  saveParcelas(req.params.id, depois);
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

// ---------- PARCELAS (CONTAS A RECEBER) ----------
app.get('/api/parcelas', (_, res) => {
  const daVenda = db.prepare(`
    SELECT p.id, p.numero, p.valor, p.vencimento, p.pago, p.pago_em,
           v.nome as veiculo_nome, v.placa as veiculo_placa,
           c.nome as cliente_nome, c.telefone as cliente_telefone,
           'venda' as origem
    FROM parcelas_venda p
    JOIN veiculos v ON v.id = p.veiculo_id
    LEFT JOIN clientes c ON c.id = v.cliente_id
  `).all();
  const daPromissoria = db.prepare(`
    SELECT pp.id, pp.numero, pp.valor, pp.vencimento, pp.pago, pp.pago_em,
           COALESCE(v.nome, pr.descricao, 'Avulsa') as veiculo_nome, v.placa as veiculo_placa,
           COALESCE(c.nome, pr.cliente_nome_avulso) as cliente_nome, c.telefone as cliente_telefone,
           'promissoria' as origem
    FROM promissoria_parcelas pp
    JOIN promissorias pr ON pr.id = pp.promissoria_id
    LEFT JOIN veiculos v ON v.id = pr.veiculo_id
    LEFT JOIN clientes c ON c.id = pr.cliente_id
  `).all();
  ok(res, [...daVenda, ...daPromissoria].sort((a,b)=>a.vencimento.localeCompare(b.vencimento)));
});
app.put('/api/receber/:origem/:id', (req, res) => {
  const tabela = req.params.origem === 'promissoria' ? 'promissoria_parcelas' : 'parcelas_venda';
  const item = db.prepare(`SELECT * FROM ${tabela} WHERE id=?`).get(req.params.id);
  if (!item) return err(res, 'Parcela nao encontrada', 404);
  const pago = req.body.pago ? 1 : 0;
  db.prepare(`UPDATE ${tabela} SET pago=?, pago_em=? WHERE id=?`)
    .run(pago, pago ? new Date().toISOString().slice(0,10) : null, req.params.id);
  ok(res, db.prepare(`SELECT * FROM ${tabela} WHERE id=?`).get(req.params.id));
});
app.put('/api/parcelas/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM parcelas_venda WHERE id=?').get(req.params.id);
  if (!item) return err(res, 'Parcela nao encontrada', 404);
  const pago = req.body.pago ? 1 : 0;
  db.prepare('UPDATE parcelas_venda SET pago=?, pago_em=? WHERE id=?')
    .run(pago, pago ? new Date().toISOString().slice(0,10) : null, req.params.id);
  ok(res, db.prepare('SELECT * FROM parcelas_venda WHERE id=?').get(req.params.id));
});

// ---------- PROMISSORIAS ----------
function gerarParcelasPromissoria(promId, valorTotal, parcelas, dataEmissao) {
  db.prepare('DELETE FROM promissoria_parcelas WHERE promissoria_id=?').run(promId);
  const n = Math.max(1, parcelas || 1);
  const valorParcela = valorTotal / n;
  const dataBase = dataEmissao ? new Date(dataEmissao + 'T12:00:00') : new Date();
  const ins = db.prepare('INSERT INTO promissoria_parcelas (promissoria_id,numero,valor,vencimento) VALUES (?,?,?,?)');
  for (let i = 1; i <= n; i++) {
    const venc = new Date(dataBase);
    venc.setMonth(venc.getMonth() + i);
    ins.run(promId, i, valorParcela, venc.toISOString().slice(0, 10));
  }
}

app.get('/api/promissorias', (_, res) => {
  const rows = db.prepare(`
    SELECT p.*, v.nome as veiculo_nome, v.placa as veiculo_placa,
           c.nome as cliente_nome_cad, c.telefone as cliente_telefone, c.cpf_cnpj as cliente_cpf_cnpj, c.endereco as cliente_endereco
    FROM promissorias p
    LEFT JOIN veiculos v ON v.id = p.veiculo_id
    LEFT JOIN clientes c ON c.id = p.cliente_id
    ORDER BY p.criado_em DESC
  `).all();
  const parcelas = db.prepare('SELECT * FROM promissoria_parcelas ORDER BY numero').all();
  ok(res, rows.map(r => ({
    ...r,
    cliente_nome: r.cliente_nome_cad || r.cliente_nome_avulso,
    parcelas_detalhe: parcelas.filter(p => p.promissoria_id === r.id)
  })));
});

app.post('/api/promissorias', (req, res) => {
  const b = req.body;
  if (!b.valor_total || b.valor_total <= 0) return err(res, 'Valor total obrigatorio');
  if (!b.cliente_id && !b.cliente_nome_avulso) return err(res, 'Informe o cliente ou o nome de quem vai assinar');
  const r = db.prepare(`INSERT INTO promissorias (veiculo_id,cliente_id,cliente_nome_avulso,descricao,valor_total,parcelas,data_emissao)
    VALUES (?,?,?,?,?,?,?)`)
    .run(b.veiculo_id || null, b.cliente_id || null, b.cliente_id ? null : (b.cliente_nome_avulso || null),
         b.descricao || '', b.valor_total, b.parcelas || 1, b.data_emissao || new Date().toISOString().slice(0, 10));
  gerarParcelasPromissoria(r.lastInsertRowid, b.valor_total, b.parcelas || 1, b.data_emissao);
  ok(res, db.prepare('SELECT * FROM promissorias WHERE id=?').get(r.lastInsertRowid));
});

app.post('/api/veiculos/:id/promissoria', (req, res) => {
  const v = db.prepare('SELECT * FROM veiculos WHERE id=?').get(req.params.id);
  if (!v) return err(res, 'Veiculo nao encontrado', 404);
  if (!v.cliente_id) return err(res, 'Esse veiculo nao tem cliente vinculado a venda');
  let prom = db.prepare('SELECT * FROM promissorias WHERE veiculo_id=?').get(v.id);
  const valorTotal = (v.valor_venda || 0) - (v.entrada || 0);
  const parcelas = v.parcelas || 1;
  if (!prom) {
    const r = db.prepare(`INSERT INTO promissorias (veiculo_id,cliente_id,descricao,valor_total,parcelas,data_emissao)
      VALUES (?,?,?,?,?,?)`)
      .run(v.id, v.cliente_id, 'Venda do veiculo ' + v.nome, valorTotal, parcelas, v.data_venda || new Date().toISOString().slice(0, 10));
    gerarParcelasPromissoria(r.lastInsertRowid, valorTotal, parcelas, v.data_venda);
    prom = db.prepare('SELECT * FROM promissorias WHERE id=?').get(r.lastInsertRowid);
  }
  const parcelasDetalhe = db.prepare('SELECT * FROM promissoria_parcelas WHERE promissoria_id=? ORDER BY numero').all(prom.id);
  const cliente = db.prepare('SELECT * FROM clientes WHERE id=?').get(v.cliente_id);
  ok(res, { promissoria: prom, parcelas: parcelasDetalhe, cliente, veiculo: v });
});

app.get('/api/promissorias/:id', (req, res) => {
  const prom = db.prepare('SELECT * FROM promissorias WHERE id=?').get(req.params.id);
  if (!prom) return err(res, 'Promissoria nao encontrada', 404);
  const parcelas = db.prepare('SELECT * FROM promissoria_parcelas WHERE promissoria_id=? ORDER BY numero').all(prom.id);
  const cliente = prom.cliente_id ? db.prepare('SELECT * FROM clientes WHERE id=?').get(prom.cliente_id) : null;
  const veiculo = prom.veiculo_id ? db.prepare('SELECT * FROM veiculos WHERE id=?').get(prom.veiculo_id) : null;
  ok(res, { promissoria: prom, parcelas, cliente, veiculo });
});

app.delete('/api/promissorias/:id', (req, res) => {
  db.prepare('DELETE FROM promissorias WHERE id=?').run(req.params.id);
  ok(res, { id: req.params.id });
});

app.put('/api/promissoria-parcelas/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM promissoria_parcelas WHERE id=?').get(req.params.id);
  if (!item) return err(res, 'Parcela nao encontrada', 404);
  const pago = req.body.pago ? 1 : 0;
  db.prepare('UPDATE promissoria_parcelas SET pago=?, pago_em=? WHERE id=?')
    .run(pago, pago ? new Date().toISOString().slice(0,10) : null, req.params.id);
  ok(res, db.prepare('SELECT * FROM promissoria_parcelas WHERE id=?').get(req.params.id));
});

// ---------- CLIENTES ----------
app.get('/api/clientes', (_, res) => ok(res, db.prepare('SELECT * FROM clientes ORDER BY nome').all()));
app.post('/api/clientes', (req, res) => {
  const { tipo, nome, telefone, email, cpf_cnpj, endereco, obs } = req.body;
  if (!nome) return err(res, 'Nome obrigatorio');
  const r = db.prepare('INSERT INTO clientes (tipo,nome,telefone,email,cpf_cnpj,endereco,obs) VALUES (?,?,?,?,?,?,?)')
    .run(tipo || 'cliente', nome, telefone||'', email||'', cpf_cnpj||'', endereco||'', obs||'');
  ok(res, db.prepare('SELECT * FROM clientes WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/clientes/:id', (req, res) => {
  const { tipo, nome, telefone, email, cpf_cnpj, endereco, obs } = req.body;
  if (!nome) return err(res, 'Nome obrigatorio');
  db.prepare('UPDATE clientes SET tipo=?,nome=?,telefone=?,email=?,cpf_cnpj=?,endereco=?,obs=? WHERE id=?')
    .run(tipo || 'cliente', nome, telefone||'', email||'', cpf_cnpj||'', endereco||'', obs||'', req.params.id);
  ok(res, db.prepare('SELECT * FROM clientes WHERE id=?').get(req.params.id));
});
app.delete('/api/clientes/:id', (req, res) => {
  if (db.prepare('SELECT id FROM veiculos WHERE cliente_id=? LIMIT 1').get(req.params.id))
    return err(res, 'Cliente vinculado a uma venda, nao pode ser excluido.');
  db.prepare('DELETE FROM clientes WHERE id=?').run(req.params.id);
  ok(res, { id: req.params.id });
});

// ---------- CHECKLIST ----------
app.get('/api/veiculos/:id/checklist', (req, res) => {
  ok(res, db.prepare('SELECT * FROM checklist_itens WHERE veiculo_id=? ORDER BY criado_em').all(req.params.id));
});
app.post('/api/veiculos/:id/checklist', (req, res) => {
  const { texto } = req.body;
  if (!texto) return err(res, 'Texto obrigatorio');
  const veiculo = db.prepare('SELECT id FROM veiculos WHERE id=?').get(req.params.id);
  if (!veiculo) return err(res, 'Veiculo nao encontrado', 404);
  const r = db.prepare('INSERT INTO checklist_itens (veiculo_id, texto) VALUES (?,?)').run(req.params.id, texto);
  ok(res, db.prepare('SELECT * FROM checklist_itens WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/checklist/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM checklist_itens WHERE id=?').get(req.params.id);
  if (!item) return err(res, 'Item nao encontrado', 404);
  const concluido = req.body.concluido !== undefined ? (req.body.concluido ? 1 : 0) : item.concluido;
  const texto = req.body.texto !== undefined ? req.body.texto : item.texto;
  db.prepare('UPDATE checklist_itens SET texto=?, concluido=? WHERE id=?').run(texto, concluido, req.params.id);
  ok(res, db.prepare('SELECT * FROM checklist_itens WHERE id=?').get(req.params.id));
});
app.delete('/api/checklist/:id', (req, res) => {
  db.prepare('DELETE FROM checklist_itens WHERE id=?').run(req.params.id);
  ok(res, { id: req.params.id });
});

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
app.listen(PORT, () => console.log(`aclera.cars rodando na porta ${PORT}`));
