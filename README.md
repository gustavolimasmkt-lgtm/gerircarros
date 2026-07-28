# AutoGestão v5

Evolução do AutoGestão original: login real, contas com extrato, lançamentos
gerais (não só custo por carro), auditoria de edição/exclusão e alerta de
material parado há 15+ dias.

## Rodando localmente
```
npm install
npm start
```
Abre em http://localhost:3000. Primeiro acesso: clique em "Não tem conta?
Cadastre-se" pra criar seu usuário e o do seu sócio.

## Deploy no Railway — PASSO CRÍTICO: volume persistente
Sem isso, todo redeploy apaga o banco de dados.

1. No serviço no Railway, vá em **Settings → Volumes**.
2. Clique em **New Volume**.
3. Mount path: `/app/data`
4. Redeploy o serviço.

O `server.js` já lê `DB_PATH` do ambiente (padrão: `./data/autogestao.db`),
então não precisa configurar variável nenhuma além do volume.

## O que mudou em relação à versão anterior
- **Login real** (`usuarios` + `sessoes`, senha com bcrypt, cookie httpOnly).
- **`contas`**: PJ e PF Gustavo, criadas automaticamente. Extensível se
  aparecer uma terceira conta.
- **`lancamentos`** substitui `custos`: aceita entrada ou saída, com
  `veiculo_id` opcional (nulo = despesa/receita geral, ex: aluguel, ads).
- **Extrato por conta** com saldo corrente.
- **Auditoria**: toda edição/exclusão de lançamento grava quem fez e o
  antes/depois em `lancamentos_auditoria`.
- **Alerta de 15 dias**: campo `material_pronto` + `data_gravacao` no
  veículo; rota `/api/alertas` lista quem estourou o prazo.

## Pendente (combinado para próximas fases)
1. **Acerto de sócio**: o cálculo de "quanto o sócio pagou de custo" foi
   zerado no código (`csocio = 0`) porque a lógica antiga confundia "conta
   de origem do dinheiro" com "quem economicamente banca o custo entre você
   e o sócio". Precisa de uma regra explícita antes de eu reativar isso.
2. Tabela FIPE (dependência de API de terceiro, não há uma oficial estável).
3. IA lendo print de pagamento e lançando automaticamente (fila de
   confirmação antes de gravar).

## Não testado em ambiente real
O `better-sqlite3` não compilou no sandbox onde este código foi escrito
(domínio `nodejs.org` bloqueado ali, não é um problema do Railway). O código
foi validado só por sintaxe (`node --check`) e revisão manual de cada rota —
não rodou de ponta a ponta. Teste local ou em um ambiente de staging antes
de apontar pro banco de produção.
