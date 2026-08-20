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
    is_admin INTEGER DEFAULT 0,
    ve_financeiro INTEGER DEFAULT 0,
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
    versao_motor TEXT,
    postado_instagram INTEGER DEFAULT 0,
    anuncio_ativo INTEGER DEFAULT 0,
    status_anuncio TEXT DEFAULT 'nenhum',
    precisa_gravar INTEGER DEFAULT 0,
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

  CREATE TABLE IF NOT EXISTS tipos_documento (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    ativo INTEGER DEFAULT 1,
    ordem INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS veiculo_documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
    tipo_documento_id INTEGER NOT NULL REFERENCES tipos_documento(id),
    concluido INTEGER DEFAULT 0,
    concluido_em TEXT
  );
  CREATE TABLE IF NOT EXISTS tipos_preparacao (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    ativo INTEGER DEFAULT 1,
    ordem INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS veiculo_preparacao (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE,
    tipo_preparacao_id INTEGER NOT NULL REFERENCES tipos_preparacao(id),
    concluido INTEGER DEFAULT 0,
    concluido_em TEXT
  );
  CREATE TABLE IF NOT EXISTS permissoes_usuario (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    modulo TEXT NOT NULL,
    UNIQUE(usuario_id, modulo)
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
  "ALTER TABLE veiculos ADD COLUMN versao_motor TEXT",
  "ALTER TABLE veiculos ADD COLUMN postado_instagram INTEGER DEFAULT 0",
  "ALTER TABLE veiculos ADD COLUMN anuncio_ativo INTEGER DEFAULT 0",
  "ALTER TABLE veiculos ADD COLUMN status_anuncio TEXT DEFAULT 'nenhum'",
  "ALTER TABLE veiculos ADD COLUMN precisa_gravar INTEGER DEFAULT 0",
  "ALTER TABLE usuarios ADD COLUMN is_admin INTEGER DEFAULT 0",
  "ALTER TABLE usuarios ADD COLUMN ve_financeiro INTEGER DEFAULT 0",
]) {
  try { db.exec(col); } catch (e) { /* coluna já existe, ignora */ }
}

// garante que sempre existe pelo menos um admin: promove o usuario mais antigo se ninguem for admin ainda
const semAdmin = db.prepare('SELECT COUNT(*) as n FROM usuarios WHERE is_admin=1').get().n === 0;
if (semAdmin) {
  const maisAntigo = db.prepare('SELECT id FROM usuarios ORDER BY criado_em ASC LIMIT 1').get();
  if (maisAntigo) db.prepare('UPDATE usuarios SET is_admin=1, ve_financeiro=1 WHERE id=?').run(maisAntigo.id);
}

// catalogo padrao de documentos e preparacao, so semeia se estiver vazio
if (db.prepare('SELECT COUNT(*) as n FROM tipos_documento').get().n === 0) {
  const insDoc = db.prepare('INSERT INTO tipos_documento (nome, ordem) VALUES (?,?)');
  ['CRV Impresso', 'CRV em PDF', 'Procuração'].forEach((n, i) => insDoc.run(n, i));
}
if (db.prepare('SELECT COUNT(*) as n FROM tipos_preparacao').get().n === 0) {
  const insPrep = db.prepare('INSERT INTO tipos_preparacao (nome, ordem) VALUES (?,?)');
  ['Lavagem Fora', 'Lavagem Dentro', 'Higienização de Estofados'].forEach((n, i) => insPrep.run(n, i));
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
  const user = db.prepare('SELECT id, nome, email, is_admin, ve_financeiro FROM usuarios WHERE id=?').get(sess.usuario_id);
  if (!user) return err(res, 'Usuario nao encontrado', 401);
  user.is_admin = !!user.is_admin;
  user.ve_financeiro = !!user.ve_financeiro;
  user.modulos = db.prepare('SELECT modulo FROM permissoes_usuario WHERE usuario_id=?').all(user.id).map(r => r.modulo);
  req.user = user;
  next();
}
function temModulo(user, modulo) { return user.is_admin || user.modulos.includes(modulo); }
function requireModulo(modulo) {
  return (req, res, next) => {
    if (!temModulo(req.user, modulo)) return err(res, 'Sem permissao para este modulo', 403);
    next();
  };
}
function requireFinanceiro(req, res, next) {
  if (!req.user.is_admin && !req.user.ve_financeiro) return err(res, 'Sem permissao para ver dados financeiros', 403);
  next();
}

app.post('/api/auth/registrar', (req, res) => {
  const { nome, email, senha, modulos, ve_financeiro } = req.body;
  if (!nome || !email || !senha) return err(res, 'Nome, email e senha obrigatorios');
  if (senha.length < 6) return err(res, 'Senha precisa de ao menos 6 caracteres');

  const totalUsuarios = db.prepare('SELECT COUNT(*) as n FROM usuarios').get().n;
  const ehPrimeiroUsuario = totalUsuarios === 0;
  if (!ehPrimeiroUsuario) {
    const token = req.cookies.sessao;
    const sess = token && db.prepare('SELECT * FROM sessoes WHERE token=?').get(token);
    const logado = sess && new Date(sess.expira_em) >= new Date();
    if (!logado) return err(res, 'Cadastro fechado. Peça para quem já tem acesso te cadastrar.', 403);
    const quemCria = logado && db.prepare('SELECT is_admin FROM usuarios WHERE id=?').get(sess.usuario_id);
    if (!quemCria || !quemCria.is_admin) return err(res, 'Só um administrador pode cadastrar novos usuarios.', 403);
  }

  const existe = db.prepare('SELECT id FROM usuarios WHERE email=?').get(email.toLowerCase());
  if (existe) return err(res, 'Email ja cadastrado');
  const hash = bcrypt.hashSync(senha, 10);
  const recoveryCode = crypto.randomBytes(6).toString('hex').toUpperCase().match(/.{1,4}/g).join('-'); // ex: A1B2-C3D4-E5F6
  const recoveryHash = bcrypt.hashSync(recoveryCode, 10);
  const r = db.prepare('INSERT INTO usuarios (nome, email, senha_hash, recovery_code_hash, is_admin, ve_financeiro) VALUES (?,?,?,?,?,?)')
    .run(nome, email.toLowerCase(), hash, recoveryHash, ehPrimeiroUsuario ? 1 : 0, (ehPrimeiroUsuario || ve_financeiro) ? 1 : 0);
  if (!ehPrimeiroUsuario && Array.isArray(modulos)) {
    const insMod = db.prepare('INSERT OR IGNORE INTO permissoes_usuario (usuario_id, modulo) VALUES (?,?)');
    modulos.forEach(m => insMod.run(r.lastInsertRowid, m));
  }
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

// ---------- USUARIOS / PERMISSOES (so admin) ----------
app.get('/api/usuarios', (req, res) => {
  if (!req.user.is_admin) return err(res, 'Só um administrador pode ver esta lista', 403);
  const usuarios = db.prepare('SELECT id, nome, email, is_admin, ve_financeiro, criado_em FROM usuarios ORDER BY criado_em').all();
  const todasPermissoes = db.prepare('SELECT usuario_id, modulo FROM permissoes_usuario').all();
  ok(res, usuarios.map(u => ({
    ...u, is_admin: !!u.is_admin, ve_financeiro: !!u.ve_financeiro,
    modulos: todasPermissoes.filter(p => p.usuario_id === u.id).map(p => p.modulo)
  })));
});
app.put('/api/usuarios/:id/permissoes', (req, res) => {
  if (!req.user.is_admin) return err(res, 'Só um administrador pode alterar permissões', 403);
  const alvo = db.prepare('SELECT * FROM usuarios WHERE id=?').get(req.params.id);
  if (!alvo) return err(res, 'Usuario nao encontrado', 404);
  if (alvo.is_admin) return err(res, 'Não é possível alterar permissões de um administrador.', 403);
  const { modulos, ve_financeiro } = req.body;
  db.prepare('UPDATE usuarios SET ve_financeiro=? WHERE id=?').run(ve_financeiro ? 1 : 0, req.params.id);
  db.prepare('DELETE FROM permissoes_usuario WHERE usuario_id=?').run(req.params.id);
  if (Array.isArray(modulos)) {
    const insMod = db.prepare('INSERT OR IGNORE INTO permissoes_usuario (usuario_id, modulo) VALUES (?,?)');
    modulos.forEach(m => insMod.run(req.params.id, m));
  }
  ok(res, { id: req.params.id });
});
app.delete('/api/usuarios/:id', (req, res) => {
  if (!req.user.is_admin) return err(res, 'Só um administrador pode excluir usuarios', 403);
  const alvo = db.prepare('SELECT * FROM usuarios WHERE id=?').get(req.params.id);
  if (!alvo) return err(res, 'Usuario nao encontrado', 404);
  if (alvo.is_admin) return err(res, 'Não é possível excluir um administrador.', 403);
  db.prepare('DELETE FROM usuarios WHERE id=?').run(req.params.id);
  ok(res, { id: req.params.id });
});

// ---------- SOCIOS ----------
app.get('/api/socios', requireModulo('socios'), (_, res) => ok(res, db.prepare('SELECT * FROM socios ORDER BY nome').all()));
app.post('/api/socios', requireModulo('socios'), (req, res) => {
  const { nome, tel, cpf, email, pct_padrao, obs } = req.body;
  if (!nome) return err(res, 'Nome obrigatorio');
  const r = db.prepare('INSERT INTO socios (nome,tel,cpf,email,pct_padrao,obs) VALUES (?,?,?,?,?,?)')
    .run(nome, tel||'', cpf||'', email||'', pct_padrao ?? 50, obs||'');
  ok(res, db.prepare('SELECT * FROM socios WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/socios/:id', requireModulo('socios'), (req, res) => {
  const { nome, tel, cpf, email, pct_padrao, obs } = req.body;
  if (!nome) return err(res, 'Nome obrigatorio');
  db.prepare('UPDATE socios SET nome=?,tel=?,cpf=?,email=?,pct_padrao=?,obs=? WHERE id=?')
    .run(nome, tel||'', cpf||'', email||'', pct_padrao ?? 50, obs||'', req.params.id);
  ok(res, db.prepare('SELECT * FROM socios WHERE id=?').get(req.params.id));
});
app.delete('/api/socios/:id', requireModulo('socios'), (req, res) => {
  if (db.prepare('SELECT id FROM veiculos WHERE socio_id=? LIMIT 1').get(req.params.id))
    return err(res, 'Socio vinculado a veiculos.');
  db.prepare('DELETE FROM socios WHERE id=?').run(req.params.id);
  ok(res, { id: req.params.id });
});

// ---------- VEICULOS ----------
app.get('/api/veiculos', (req, res) => {
  const veiculos = db.prepare(`
    SELECT v.*, c.nome as cliente_nome, c.telefone as cliente_telefone, c.cpf_cnpj as cliente_cpf_cnpj
    FROM veiculos v LEFT JOIN clientes c ON c.id = v.cliente_id
    ORDER BY v.criado_em DESC
  `).all();
  const hoje = new Date();
  const CAMPOS_FINANCEIROS = ['valor_compra','valor_venda','troca','valor_minimo_dono','preco_pretendido',
    'entrada','parcelas','taxa_comissao','forma_pagamento','tem_socio','socio_id','socio_pct'];
  const comCalculos = veiculos.map(v => {
    const dias_desde_gravacao = v.data_gravacao
      ? Math.floor((hoje - new Date(v.data_gravacao)) / 86400000) : null;
    let vv = {
      ...v,
      dias_desde_gravacao,
      alerta_material: v.material_pronto === 1 && dias_desde_gravacao !== null
        && dias_desde_gravacao >= 15 && v.status !== 'Vendido'
    };
    if (!req.user.is_admin && !req.user.ve_financeiro) {
      CAMPOS_FINANCEIROS.forEach(c => delete vv[c]);
    }
    return vv;
  });
  ok(res, comCalculos);
});

app.post('/api/veiculos', requireModulo('veiculos'), (req, res) => {
  try {
  const b = req.body;
  const consig = b.tipo_aquisicao === 'consignacao';
  if (!b.nome) return err(res, 'Nome obrigatorio');
  if (!consig && !b.valor_compra) return err(res, 'Valor de compra obrigatorio');
  if (consig && !b.consignante_nome) return err(res, 'Nome do consignante obrigatorio');
  if (consig && !b.valor_minimo_dono) return err(res, 'Valor minimo combinado com o dono obrigatorio');
  if (b.placa && b.placa.trim()) {
    const dup = db.prepare("SELECT id, nome FROM veiculos WHERE UPPER(REPLACE(placa,'-','')) = UPPER(REPLACE(?,'-',''))").get(b.placa.trim());
    if (dup) return err(res, `Placa já cadastrada no veículo "${dup.nome}" (id ${dup.id}).`);
  }
  const r = db.prepare(`INSERT INTO veiculos
    (nome,placa,ano,data_compra,valor_compra,tem_socio,socio_id,socio_pct,status,data_venda,valor_venda,troca,obs,data_entrada,material_pronto,data_gravacao,tipo_aquisicao,consignante_nome,consignante_contato,valor_minimo_dono,cor,km,chassi,preco_pretendido,cliente_id,forma_pagamento,entrada,parcelas,taxa_comissao,versao_motor,postado_instagram,anuncio_ativo,status_anuncio,precisa_gravar)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.nome, b.placa||'', b.ano||null, b.data_compra||'', consig ? 0 : b.valor_compra, b.tem_socio||'nao',
         b.socio_id||null, b.socio_pct ?? 50, b.status||'Disponivel', b.data_venda||'', b.valor_venda||0,
         b.troca||0, b.obs||'', b.data_entrada || new Date().toISOString().slice(0,10),
         b.material_pronto ? 1 : 0, b.data_gravacao||null, b.tipo_aquisicao||'compra',
         b.consignante_nome||null, b.consignante_contato||null, consig ? b.valor_minimo_dono : null,
         b.cor||null, b.km||null, b.chassi||null, b.preco_pretendido||null,
         b.cliente_id||null, b.forma_pagamento||null, b.entrada||null, b.parcelas||null, b.taxa_comissao||null,
         b.versao_motor||null, b.postado_instagram?1:0, b.anuncio_ativo?1:0, b.status_anuncio||'nenhum', b.precisa_gravar?1:0);
  saveCustos(r.lastInsertRowid, b.custos);
  const novo = db.prepare('SELECT * FROM veiculos WHERE id=?').get(r.lastInsertRowid);
  saveParcelas(r.lastInsertRowid, novo);
  const tiposDoc = db.prepare('SELECT id FROM tipos_documento WHERE ativo=1').all();
  const insDoc = db.prepare('INSERT INTO veiculo_documentos (veiculo_id, tipo_documento_id) VALUES (?,?)');
  tiposDoc.forEach(t => insDoc.run(r.lastInsertRowid, t.id));
  db.prepare('INSERT INTO veiculos_auditoria (veiculo_id,usuario_id,acao,dados_depois) VALUES (?,?,?,?)')
    .run(r.lastInsertRowid, req.user.id, 'criado', JSON.stringify(novo));
  ok(res, novo);
  } catch (e) { err(res, 'Erro ao salvar veiculo: ' + e.message, 500); }
});

app.put('/api/veiculos/:id', (req, res) => {
  try {
  const b = req.body;
  const consig = b.tipo_aquisicao === 'consignacao';
  const antes = db.prepare('SELECT * FROM veiculos WHERE id=?').get(req.params.id);
  if (!antes) return err(res, 'Veiculo nao encontrado', 404);
  if (!b.nome) return err(res, 'Nome obrigatorio');
  if (!consig && !b.valor_compra) return err(res, 'Valor de compra obrigatorio');
  if (consig && !b.consignante_nome) return err(res, 'Nome do consignante obrigatorio');
  if (consig && !b.valor_minimo_dono) return err(res, 'Valor minimo combinado com o dono obrigatorio');
  if (b.placa && b.placa.trim()) {
    const dup = db.prepare("SELECT id, nome FROM veiculos WHERE UPPER(REPLACE(placa,'-','')) = UPPER(REPLACE(?,'-','')) AND id != ?").get(b.placa.trim(), req.params.id);
    if (dup) return err(res, `Placa já cadastrada no veículo "${dup.nome}" (id ${dup.id}).`);
  }
  db.prepare(`UPDATE veiculos SET nome=?,placa=?,ano=?,data_compra=?,valor_compra=?,tem_socio=?,socio_id=?,socio_pct=?,
    status=?,data_venda=?,valor_venda=?,troca=?,obs=?,data_entrada=?,material_pronto=?,data_gravacao=?,
    tipo_aquisicao=?,consignante_nome=?,consignante_contato=?,valor_minimo_dono=?,
    cor=?,km=?,chassi=?,preco_pretendido=?,cliente_id=?,forma_pagamento=?,entrada=?,parcelas=?,taxa_comissao=?,
    versao_motor=?,postado_instagram=?,anuncio_ativo=?,status_anuncio=?,precisa_gravar=? WHERE id=?`)
    .run(b.nome, b.placa||'', b.ano||null, b.data_compra||'', consig ? 0 : b.valor_compra, b.tem_socio||'nao',
         b.socio_id||null, b.socio_pct ?? 50, b.status||'Disponivel', b.data_venda||'', b.valor_venda||0,
         b.troca||0, b.obs||'', b.data_entrada||null, b.material_pronto ? 1 : 0, b.data_gravacao||null,
         b.tipo_aquisicao||'compra', b.consignante_nome||null, b.consignante_contato||null,
         consig ? b.valor_minimo_dono : null,
         b.cor||null, b.km||null, b.chassi||null, b.preco_pretendido||null,
         b.cliente_id||null, b.forma_pagamento||null, b.entrada||null, b.parcelas||null, b.taxa_comissao||null,
         b.versao_motor||null, b.postado_instagram?1:0, b.anuncio_ativo?1:0, b.status_anuncio||'nenhum', b.precisa_gravar?1:0,
         req.params.id);
  if (b.custos !== undefined) saveCustos(req.params.id, b.custos);
  const depois = db.prepare('SELECT * FROM veiculos WHERE id=?').get(req.params.id);
  saveParcelas(req.params.id, depois);
  db.prepare('INSERT INTO veiculos_auditoria (veiculo_id,usuario_id,acao,dados_antes,dados_depois) VALUES (?,?,?,?,?)')
    .run(req.params.id, req.user.id, 'editado', JSON.stringify(antes), JSON.stringify(depois));
  ok(res, depois);
  } catch (e) { err(res, 'Erro ao editar veiculo: ' + e.message, 500); }
});

app.delete('/api/veiculos/:id', requireModulo('veiculos'), (req, res) => {
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
app.get('/api/custos', requireFinanceiro, (_, res) => ok(res, db.prepare('SELECT * FROM custos ORDER BY veiculo_id, criado_em').all()));

// ---------- PARCELAS (CONTAS A RECEBER) ----------
app.get('/api/parcelas', requireModulo('receber'), (_, res) => {
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
app.put('/api/receber/:origem/:id', requireModulo('receber'), (req, res) => {
  const tabela = req.params.origem === 'promissoria' ? 'promissoria_parcelas' : 'parcelas_venda';
  const item = db.prepare(`SELECT * FROM ${tabela} WHERE id=?`).get(req.params.id);
  if (!item) return err(res, 'Parcela nao encontrada', 404);
  const pago = req.body.pago ? 1 : 0;
  db.prepare(`UPDATE ${tabela} SET pago=?, pago_em=? WHERE id=?`)
    .run(pago, pago ? new Date().toISOString().slice(0,10) : null, req.params.id);
  ok(res, db.prepare(`SELECT * FROM ${tabela} WHERE id=?`).get(req.params.id));
});
app.put('/api/parcelas/:id', requireModulo('receber'), (req, res) => {
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

app.get('/api/promissorias', requireModulo('promissorias'), (_, res) => {
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

app.post('/api/promissorias', requireModulo('promissorias'), (req, res) => {
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

app.put('/api/promissorias/:id', requireModulo('promissorias'), (req, res) => {
  const prom = db.prepare('SELECT * FROM promissorias WHERE id=?').get(req.params.id);
  if (!prom) return err(res, 'Promissoria nao encontrada', 404);
  const b = req.body;
  db.prepare('UPDATE promissorias SET descricao=?, cliente_id=?, cliente_nome_avulso=? WHERE id=?')
    .run(b.descricao !== undefined ? b.descricao : prom.descricao,
         b.cliente_id !== undefined ? b.cliente_id : prom.cliente_id,
         b.cliente_id ? null : (b.cliente_nome_avulso !== undefined ? b.cliente_nome_avulso : prom.cliente_nome_avulso),
         req.params.id);
  ok(res, db.prepare('SELECT * FROM promissorias WHERE id=?').get(req.params.id));
});
app.delete('/api/promissorias/:id', requireModulo('promissorias'), (req, res) => {
  db.prepare('DELETE FROM promissorias WHERE id=?').run(req.params.id);
  ok(res, { id: req.params.id });
});

app.put('/api/promissoria-parcelas/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM promissoria_parcelas WHERE id=?').get(req.params.id);
  if (!item) return err(res, 'Parcela nao encontrada', 404);
  const pago = req.body.pago !== undefined ? (req.body.pago ? 1 : 0) : item.pago;
  const valor = req.body.valor !== undefined ? req.body.valor : item.valor;
  const vencimento = req.body.vencimento !== undefined ? req.body.vencimento : item.vencimento;
  db.prepare('UPDATE promissoria_parcelas SET pago=?, pago_em=?, valor=?, vencimento=? WHERE id=?')
    .run(pago, pago ? (item.pago_em || new Date().toISOString().slice(0,10)) : null, valor, vencimento, req.params.id);
  const atualizado = db.prepare('SELECT * FROM promissoria_parcelas WHERE id=?').get(req.params.id);
  // mantem o valor_total da promissoria coerente com a soma das parcelas
  const soma = db.prepare('SELECT SUM(valor) as t FROM promissoria_parcelas WHERE promissoria_id=?').get(atualizado.promissoria_id).t;
  db.prepare('UPDATE promissorias SET valor_total=? WHERE id=?').run(soma, atualizado.promissoria_id);
  ok(res, atualizado);
});

// ---------- CLIENTES ----------
app.get('/api/clientes', requireModulo('clientes'), (_, res) => ok(res, db.prepare('SELECT * FROM clientes ORDER BY nome').all()));
app.post('/api/clientes', requireModulo('clientes'), (req, res) => {
  const { tipo, nome, telefone, email, cpf_cnpj, endereco, obs } = req.body;
  if (!nome) return err(res, 'Nome obrigatorio');
  const r = db.prepare('INSERT INTO clientes (tipo,nome,telefone,email,cpf_cnpj,endereco,obs) VALUES (?,?,?,?,?,?,?)')
    .run(tipo || 'cliente', nome, telefone||'', email||'', cpf_cnpj||'', endereco||'', obs||'');
  ok(res, db.prepare('SELECT * FROM clientes WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/clientes/:id', requireModulo('clientes'), (req, res) => {
  const { tipo, nome, telefone, email, cpf_cnpj, endereco, obs } = req.body;
  if (!nome) return err(res, 'Nome obrigatorio');
  db.prepare('UPDATE clientes SET tipo=?,nome=?,telefone=?,email=?,cpf_cnpj=?,endereco=?,obs=? WHERE id=?')
    .run(tipo || 'cliente', nome, telefone||'', email||'', cpf_cnpj||'', endereco||'', obs||'', req.params.id);
  ok(res, db.prepare('SELECT * FROM clientes WHERE id=?').get(req.params.id));
});
app.delete('/api/clientes/:id', requireModulo('clientes'), (req, res) => {
  if (db.prepare('SELECT id FROM veiculos WHERE cliente_id=? LIMIT 1').get(req.params.id))
    return err(res, 'Cliente vinculado a uma venda, nao pode ser excluido.');
  db.prepare('DELETE FROM clientes WHERE id=?').run(req.params.id);
  ok(res, { id: req.params.id });
});

// ---------- CHECKLIST ----------
app.get('/api/veiculos/:id/checklist', requireModulo('checklist'), (req, res) => {
  ok(res, db.prepare('SELECT * FROM checklist_itens WHERE veiculo_id=? ORDER BY criado_em').all(req.params.id));
});
app.get('/api/checklist-pendentes', requireModulo('checklist'), (_, res) => {
  ok(res, db.prepare(`
    SELECT c.id, c.texto, c.veiculo_id, v.nome as veiculo_nome, v.placa as veiculo_placa
    FROM checklist_itens c JOIN veiculos v ON v.id = c.veiculo_id
    WHERE c.concluido = 0 AND v.status != 'Vendido'
    ORDER BY v.nome, c.criado_em
  `).all());
});
app.post('/api/veiculos/:id/checklist', requireModulo('checklist'), (req, res) => {
  const { texto } = req.body;
  if (!texto) return err(res, 'Texto obrigatorio');
  const veiculo = db.prepare('SELECT id FROM veiculos WHERE id=?').get(req.params.id);
  if (!veiculo) return err(res, 'Veiculo nao encontrado', 404);
  const r = db.prepare('INSERT INTO checklist_itens (veiculo_id, texto) VALUES (?,?)').run(req.params.id, texto);
  ok(res, db.prepare('SELECT * FROM checklist_itens WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/checklist/:id', requireModulo('checklist'), (req, res) => {
  const item = db.prepare('SELECT * FROM checklist_itens WHERE id=?').get(req.params.id);
  if (!item) return err(res, 'Item nao encontrado', 404);
  const concluido = req.body.concluido !== undefined ? (req.body.concluido ? 1 : 0) : item.concluido;
  const texto = req.body.texto !== undefined ? req.body.texto : item.texto;
  db.prepare('UPDATE checklist_itens SET texto=?, concluido=? WHERE id=?').run(texto, concluido, req.params.id);
  ok(res, db.prepare('SELECT * FROM checklist_itens WHERE id=?').get(req.params.id));
});
app.delete('/api/checklist/:id', requireModulo('checklist'), (req, res) => {
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

// ---------- DOCUMENTACAO ----------
app.get('/api/tipos-documento', requireModulo('documentacao'), (_, res) => {
  ok(res, db.prepare('SELECT * FROM tipos_documento WHERE ativo=1 ORDER BY ordem, nome').all());
});
app.post('/api/tipos-documento', requireModulo('documentacao'), (req, res) => {
  if (!req.body.nome) return err(res, 'Nome obrigatorio');
  const maxOrdem = db.prepare('SELECT COALESCE(MAX(ordem),0) as m FROM tipos_documento').get().m;
  const r = db.prepare('INSERT INTO tipos_documento (nome, ordem) VALUES (?,?)').run(req.body.nome, maxOrdem + 1);
  // adiciona pendente em todo carro ativo que ainda nao tem esse documento
  const veiculos = db.prepare("SELECT id FROM veiculos WHERE status != 'Vendido'").all();
  const ins = db.prepare('INSERT INTO veiculo_documentos (veiculo_id, tipo_documento_id) VALUES (?,?)');
  veiculos.forEach(v => ins.run(v.id, r.lastInsertRowid));
  ok(res, db.prepare('SELECT * FROM tipos_documento WHERE id=?').get(r.lastInsertRowid));
});
app.delete('/api/tipos-documento/:id', requireModulo('documentacao'), (req, res) => {
  db.prepare('UPDATE tipos_documento SET ativo=0 WHERE id=?').run(req.params.id);
  ok(res, { id: req.params.id });
});
app.get('/api/veiculos/:id/documentos', requireModulo('documentacao'), (req, res) => {
  ok(res, db.prepare(`
    SELECT vd.*, td.nome as tipo_nome FROM veiculo_documentos vd
    JOIN tipos_documento td ON td.id = vd.tipo_documento_id
    WHERE vd.veiculo_id=? AND td.ativo=1 ORDER BY td.ordem, td.nome
  `).all(req.params.id));
});
app.put('/api/documentos/:id', requireModulo('documentacao'), (req, res) => {
  const item = db.prepare('SELECT * FROM veiculo_documentos WHERE id=?').get(req.params.id);
  if (!item) return err(res, 'Documento nao encontrado', 404);
  const concluido = req.body.concluido ? 1 : 0;
  db.prepare('UPDATE veiculo_documentos SET concluido=?, concluido_em=? WHERE id=?')
    .run(concluido, concluido ? new Date().toISOString().slice(0,10) : null, req.params.id);
  ok(res, db.prepare('SELECT * FROM veiculo_documentos WHERE id=?').get(req.params.id));
});

// ---------- PREPARACAO ----------
app.get('/api/tipos-preparacao', requireModulo('preparacao'), (_, res) => {
  ok(res, db.prepare('SELECT * FROM tipos_preparacao WHERE ativo=1 ORDER BY ordem, nome').all());
});
app.post('/api/tipos-preparacao', requireModulo('preparacao'), (req, res) => {
  if (!req.body.nome) return err(res, 'Nome obrigatorio');
  const maxOrdem = db.prepare('SELECT COALESCE(MAX(ordem),0) as m FROM tipos_preparacao').get().m;
  const r = db.prepare('INSERT INTO tipos_preparacao (nome, ordem) VALUES (?,?)').run(req.body.nome, maxOrdem + 1);
  ok(res, db.prepare('SELECT * FROM tipos_preparacao WHERE id=?').get(r.lastInsertRowid));
});
app.delete('/api/tipos-preparacao/:id', requireModulo('preparacao'), (req, res) => {
  db.prepare('UPDATE tipos_preparacao SET ativo=0 WHERE id=?').run(req.params.id);
  ok(res, { id: req.params.id });
});
app.get('/api/veiculos/:id/preparacao', requireModulo('preparacao'), (req, res) => {
  ok(res, db.prepare(`
    SELECT vp.*, tp.nome as tipo_nome FROM veiculo_preparacao vp
    JOIN tipos_preparacao tp ON tp.id = vp.tipo_preparacao_id
    WHERE vp.veiculo_id=? AND tp.ativo=1 ORDER BY tp.ordem, tp.nome
  `).all(req.params.id));
});
app.post('/api/veiculos/:id/preparacao', requireModulo('preparacao'), (req, res) => {
  if (!req.body.tipo_preparacao_id) return err(res, 'tipo_preparacao_id obrigatorio');
  const jaTem = db.prepare('SELECT id FROM veiculo_preparacao WHERE veiculo_id=? AND tipo_preparacao_id=?')
    .get(req.params.id, req.body.tipo_preparacao_id);
  if (jaTem) return err(res, 'Esse servico ja foi selecionado pra esse carro.');
  const r = db.prepare('INSERT INTO veiculo_preparacao (veiculo_id, tipo_preparacao_id) VALUES (?,?)')
    .run(req.params.id, req.body.tipo_preparacao_id);
  ok(res, db.prepare('SELECT * FROM veiculo_preparacao WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/preparacao/:id', requireModulo('preparacao'), (req, res) => {
  const item = db.prepare('SELECT * FROM veiculo_preparacao WHERE id=?').get(req.params.id);
  if (!item) return err(res, 'Item nao encontrado', 404);
  const concluido = req.body.concluido ? 1 : 0;
  db.prepare('UPDATE veiculo_preparacao SET concluido=?, concluido_em=? WHERE id=?')
    .run(concluido, concluido ? new Date().toISOString().slice(0,10) : null, req.params.id);
  ok(res, db.prepare('SELECT * FROM veiculo_preparacao WHERE id=?').get(req.params.id));
});
app.delete('/api/preparacao/:id', requireModulo('preparacao'), (req, res) => {
  db.prepare('DELETE FROM veiculo_preparacao WHERE id=?').run(req.params.id);
  ok(res, { id: req.params.id });
});
app.get('/api/preparacao-pendentes', requireModulo('preparacao'), (_, res) => {
  ok(res, db.prepare(`
    SELECT vp.id, vp.veiculo_id, tp.nome as tipo_nome, v.nome as veiculo_nome, v.placa as veiculo_placa
    FROM veiculo_preparacao vp
    JOIN tipos_preparacao tp ON tp.id = vp.tipo_preparacao_id
    JOIN veiculos v ON v.id = vp.veiculo_id
    WHERE vp.concluido = 0 AND v.status != 'Vendido'
    ORDER BY v.nome, tp.nome
  `).all());
});

// ---------- IA (Anthropic) ----------
const PROMPTS_IA = {
  roteiro: (v) => ({
    system: `Você é um especialista em vendas de veículos usados no Brasil. Com base nos dados do carro, gere os principais diferenciais de venda e o perfil do comprador ideal, para ajudar o vendedor a criar roteiros de vídeo. Seja específico e prático, nada genérico. Responda APENAS com um JSON válido, sem markdown, no formato exato: {"diferenciais":"texto aqui","perfil":"texto aqui"}`,
    user: `Modelo: ${v.nome}\nAno: ${v.ano||'não informado'}\nVersão/Motor: ${v.versao_motor||'não informado'}\nPreço: R$ ${v.preco||'não informado'}`
  }),
  legenda: (v) => ({
    system: `Você é um especialista em marketing de vendas de carros usados no Brasil, tom comercial direto, com emojis e CTA forte. Gere DUAS legendas diferentes pro mesmo carro: uma pra post orgânico do Instagram (mais storytelling, pode ser um pouco mais longa) e uma pro anúncio pago no Meta Ads (mais direta, foco total em conversão e urgência). Use como referência de ESTILO este exemplo real do cliente (não copie o carro dele, é só o tom):\n\n"👉 Transferência grátis + tanque cheio + IPVA pago pra quem vier desse vídeo.\n🚘 Jeep Compass Longitude 2022\nSe você procura um SUV moderno, completo e com procedência impecável, presta atenção nessa oportunidade.\n✔️ Único dono\n✔️ Apenas 80.000 km\n✔️ Todas as revisões na concessionária\n💰 R$ 123.900\n🔄 Pegamos troca\n💳 Financiamos\n👉 Chama no WhatsApp agora antes que venda."\n\nResponda APENAS com um JSON válido, sem markdown, no formato exato: {"legenda_instagram":"texto aqui","legenda_anuncio":"texto aqui"}`,
    user: `Modelo: ${v.nome}\nAno: ${v.ano||'não informado'}\nVersão/Motor: ${v.versao_motor||'não informado'}\nPreço: R$ ${v.preco||'não informado'}\nDiferenciais conhecidos: ${v.diferenciais||'não informado, use o bom senso pro modelo'}\nOferta de abertura (só use se preenchido, não invente oferta): ${v.oferta_abertura||'nenhuma oferta especial dessa vez, não invente uma'}`
  }),
  gancho: (v) => ({
    system: `Você é um especialista em marketing agressivo e comercial pra vídeos curtos (Reels/TikTok/Shorts) de venda de carros usados no Brasil. Gere 5 ganchos diferentes — a primeira frase falada do vídeo, pensada pra prender atenção nos primeiros 2 segundos. Tom bem comercial e agressivo, sem ser ofensivo. Varie a abordagem entre os 5 (preço, urgência, provocação, benefício, curiosidade). Responda APENAS com um JSON válido, sem markdown, no formato exato: {"ganchos":["gancho 1","gancho 2","gancho 3","gancho 4","gancho 5"]}`,
    user: `Modelo: ${v.nome}\nAno: ${v.ano||'não informado'}\nVersão/Motor: ${v.versao_motor||'não informado'}\nPreço: R$ ${v.preco||'não informado'}`
  })
};

async function chamarClaude(system, user) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY nao configurada no Railway (Settings -> Variables)');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1200,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Erro na API da Anthropic (${r.status}): ${txt.slice(0,300)}`);
  }
  const data = await r.json();
  const texto = data.content.map(b => b.type === 'text' ? b.text : '').join('').trim();
  const limpo = texto.replace(/^```json\s*/i, '').replace(/^```\s*/,'').replace(/```\s*$/,'').trim();
  try { return JSON.parse(limpo); }
  catch (e) { throw new Error('A IA respondeu em formato inesperado: ' + texto.slice(0,200)); }
}

app.post('/api/ia/:tipo', requireModulo('marketing'), async (req, res) => {
  const gerador = PROMPTS_IA[req.params.tipo];
  if (!gerador) return err(res, 'Tipo de geracao invalido');
  try {
    const { system, user } = gerador(req.body || {});
    const resultado = await chamarClaude(system, user);
    ok(res, resultado);
  } catch (e) { err(res, e.message, 502); }
});

app.get('/api/versao-deploy', (_, res) => res.json({ versao: 'FIX-STATUS-ANUNCIO-15AGO-2226' }));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// rede de segurança: qualquer erro nao tratado em nenhuma rota /api devolve JSON, nunca HTML
app.use('/api', (error, req, res, next) => {
  console.error('Erro nao tratado:', error);
  res.status(500).json({ ok: false, error: 'Erro interno: ' + error.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`aclera.cars rodando na porta ${PORT}`));
