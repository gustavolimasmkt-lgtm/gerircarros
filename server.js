const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'autogestao.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

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

  CREATE TABLE IF NOT EXISTS contas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    tipo TEXT DEFAULT 'pj',
    saldo_inicial REAL DEFAULT 0,
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
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS lancamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL CHECK(tipo IN ('entrada','saida')),
    valor REAL NOT NULL,
    conta_id INTEGER NOT NULL REFERENCES contas(id),
    veiculo_id INTEGER REFERENCES veiculos(id) ON DELETE SET NULL,
    categoria TEXT DEFAULT 'geral',
    descricao TEXT NOT NULL,
    data TEXT DEFAULT (date('now')),
    autor_id INTEGER REFERENCES usuarios(id),
    origem TEXT DEFAULT 'manual',
    criado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS lancamentos_auditoria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lancamento_id INTEGER NOT NULL,
    autor_id INTEGER REFERENCES usuarios(id),
    acao TEXT NOT NULL,
    dados_antes TEXT,
    dados_depois TEXT,
    criado_em TEXT DEFAULT (datetime('now'))
  );
`);

// seed das 2 contas fixas se ainda nao existirem
const contaCount = db.prepare('SELECT COUNT(*) as n FROM contas').get().n;
if (contaCount === 0) {
  db.prepare("INSERT INTO contas (nome, tipo) VALUES ('PJ', 'pj')").run();
  db.prepare("INSERT INTO contas (nome, tipo) VALUES ('PF Gustavo', 'pf')").run();
}

const ok  = (res, data) => res.json({ ok: true, data });
const err = (res, msg, s = 400) => res.status(s).json({ ok: false, error: msg });

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
    // já existe pelo menos uma conta: só quem está logado pode cadastrar gente nova
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

// ---------- CONTAS ----------
app.get('/api/contas', (_, res) => ok(res, db.prepare('SELECT * FROM contas ORDER BY nome').all()));

app.get('/api/contas/:id/extrato', (req, res) => {
  const lancs = db.prepare(`
    SELECT l.*, v.nome as veiculo_nome, u.nome as autor_nome
    FROM lancamentos l
    LEFT JOIN veiculos v ON v.id = l.veiculo_id
    LEFT JOIN usuarios u ON u.id = l.autor_id
    WHERE l.conta_id=? ORDER BY l.data DESC, l.criado_em DESC
  `).all(req.params.id);
  const conta = db.prepare('SELECT * FROM contas WHERE id=?').get(req.params.id);
  if (!conta) return err(res, 'Conta nao encontrada', 404);
  let saldo = conta.saldo_inicial;
  for (const l of lancs) saldo += l.tipo === 'entrada' ? l.valor : -l.valor;
  ok(res, { conta, saldo_atual: saldo, lancamentos: lancs });
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
  const veiculos = db.prepare('SELECT * FROM veiculos ORDER BY criado_em DESC').all();
  const custosPorVeiculo = db.prepare(`
    SELECT veiculo_id, SUM(CASE WHEN tipo='saida' THEN valor ELSE 0 END) as total_custos
    FROM lancamentos WHERE veiculo_id IS NOT NULL GROUP BY veiculo_id
  `).all();
  const mapa = Object.fromEntries(custosPorVeiculo.map(c => [c.veiculo_id, c.total_custos]));
  const hoje = new Date();
  const comCalculos = veiculos.map(v => {
    const dias_parado = v.data_entrada
      ? Math.floor((hoje - new Date(v.data_entrada)) / 86400000) : null;
    const dias_desde_gravacao = v.data_gravacao
      ? Math.floor((hoje - new Date(v.data_gravacao)) / 86400000) : null;
    return {
      ...v,
      total_custos: mapa[v.id] || 0,
      investido: v.valor_compra + (mapa[v.id] || 0),
      dias_parado,
      dias_desde_gravacao,
      alerta_material: v.material_pronto === 1 && dias_desde_gravacao !== null
        && dias_desde_gravacao >= 15 && v.status !== 'Vendido'
    };
  });
  ok(res, comCalculos);
});

app.post('/api/veiculos', (req, res) => {
  const b = req.body;
  if (!b.nome || !b.valor_compra) return err(res, 'Nome e valor de compra obrigatorios');
  const r = db.prepare(`INSERT INTO veiculos
    (nome,placa,ano,data_compra,valor_compra,tem_socio,socio_id,socio_pct,status,data_venda,valor_venda,troca,obs,data_entrada,material_pronto,data_gravacao)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.nome, b.placa||'', b.ano||null, b.data_compra||'', b.valor_compra, b.tem_socio||'nao',
         b.socio_id||null, b.socio_pct ?? 50, b.status||'Disponivel', b.data_venda||'', b.valor_venda||0,
         b.troca||0, b.obs||'', b.data_entrada || new Date().toISOString().slice(0,10),
         b.material_pronto ? 1 : 0, b.data_gravacao||null);
  ok(res, db.prepare('SELECT * FROM veiculos WHERE id=?').get(r.lastInsertRowid));
});

app.put('/api/veiculos/:id', (req, res) => {
  const b = req.body;
  if (!b.nome || !b.valor_compra) return err(res, 'Nome e valor de compra obrigatorios');
  db.prepare(`UPDATE veiculos SET nome=?,placa=?,ano=?,data_compra=?,valor_compra=?,tem_socio=?,socio_id=?,socio_pct=?,
    status=?,data_venda=?,valor_venda=?,troca=?,obs=?,data_entrada=?,material_pronto=?,data_gravacao=? WHERE id=?`)
    .run(b.nome, b.placa||'', b.ano||null, b.data_compra||'', b.valor_compra, b.tem_socio||'nao',
         b.socio_id||null, b.socio_pct ?? 50, b.status||'Disponivel', b.data_venda||'', b.valor_venda||0,
         b.troca||0, b.obs||'', b.data_entrada||null, b.material_pronto ? 1 : 0, b.data_gravacao||null,
         req.params.id);
  ok(res, db.prepare('SELECT * FROM veiculos WHERE id=?').get(req.params.id));
});

app.delete('/api/veiculos/:id', (req, res) => {
  db.prepare('DELETE FROM veiculos WHERE id=?').run(req.params.id);
  ok(res, { id: req.params.id });
});

// ---------- LANCAMENTOS ----------
app.get('/api/lancamentos', (req, res) => {
  const { veiculo_id, conta_id } = req.query;
  let sql = `SELECT l.*, v.nome as veiculo_nome, c.nome as conta_nome, u.nome as autor_nome
             FROM lancamentos l
             LEFT JOIN veiculos v ON v.id = l.veiculo_id
             LEFT JOIN contas c ON c.id = l.conta_id
             LEFT JOIN usuarios u ON u.id = l.autor_id WHERE 1=1`;
  const params = [];
  if (veiculo_id) { sql += ' AND l.veiculo_id=?'; params.push(veiculo_id); }
  if (conta_id)   { sql += ' AND l.conta_id=?'; params.push(conta_id); }
  sql += ' ORDER BY l.data DESC, l.criado_em DESC';
  ok(res, db.prepare(sql).all(...params));
});

app.post('/api/lancamentos', (req, res) => {
  const b = req.body;
  if (!b.descricao || !b.valor || !b.conta_id || !b.tipo)
    return err(res, 'Descricao, valor, conta e tipo sao obrigatorios');
  if (!['entrada','saida'].includes(b.tipo)) return err(res, 'Tipo invalido');
  const r = db.prepare(`INSERT INTO lancamentos (tipo,valor,conta_id,veiculo_id,categoria,descricao,data,autor_id,origem)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(b.tipo, b.valor, b.conta_id, b.veiculo_id||null, b.categoria||'geral', b.descricao,
         b.data || new Date().toISOString().slice(0,10), req.user.id, b.origem || 'manual');
  db.prepare(`INSERT INTO lancamentos_auditoria (lancamento_id, autor_id, acao, dados_depois) VALUES (?,?,?,?)`)
    .run(r.lastInsertRowid, req.user.id, 'criado', JSON.stringify(b));
  ok(res, db.prepare('SELECT * FROM lancamentos WHERE id=?').get(r.lastInsertRowid));
});

app.put('/api/lancamentos/:id', (req, res) => {
  const antes = db.prepare('SELECT * FROM lancamentos WHERE id=?').get(req.params.id);
  if (!antes) return err(res, 'Lancamento nao encontrado', 404);
  const b = req.body;
  if (!b.descricao || !b.valor || !b.conta_id || !b.tipo)
    return err(res, 'Descricao, valor, conta e tipo sao obrigatorios');
  db.prepare(`UPDATE lancamentos SET tipo=?,valor=?,conta_id=?,veiculo_id=?,categoria=?,descricao=?,data=? WHERE id=?`)
    .run(b.tipo, b.valor, b.conta_id, b.veiculo_id||null, b.categoria||'geral', b.descricao, b.data, req.params.id);
  const depois = db.prepare('SELECT * FROM lancamentos WHERE id=?').get(req.params.id);
  db.prepare(`INSERT INTO lancamentos_auditoria (lancamento_id, autor_id, acao, dados_antes, dados_depois) VALUES (?,?,?,?,?)`)
    .run(req.params.id, req.user.id, 'editado', JSON.stringify(antes), JSON.stringify(depois));
  ok(res, depois);
});

app.delete('/api/lancamentos/:id', (req, res) => {
  const antes = db.prepare('SELECT * FROM lancamentos WHERE id=?').get(req.params.id);
  if (!antes) return err(res, 'Lancamento nao encontrado', 404);
  db.prepare('DELETE FROM lancamentos WHERE id=?').run(req.params.id);
  db.prepare(`INSERT INTO lancamentos_auditoria (lancamento_id, autor_id, acao, dados_antes) VALUES (?,?,?,?)`)
    .run(req.params.id, req.user.id, 'excluido', JSON.stringify(antes));
  ok(res, { id: req.params.id });
});

app.get('/api/lancamentos/:id/historico', (req, res) => {
  ok(res, db.prepare(`
    SELECT h.*, u.nome as autor_nome FROM lancamentos_auditoria h
    LEFT JOIN usuarios u ON u.id = h.autor_id
    WHERE h.lancamento_id=? ORDER BY h.criado_em DESC
  `).all(req.params.id));
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
app.listen(PORT, () => console.log(`AutoGestao v5 rodando na porta ${PORT}`));
