import { describe, expect, it } from 'vitest';
import { CASES, checkConversation, checkReply } from '../evals/cases.ts';

// Garante que as regras dos evals aprovam respostas boas e reprovam as ruins.
const byId = (id: string) => CASES.find((c) => c.id === id)!;

const EXAMPLES: Record<string, { good: string[]; bad: string[] }> = {
  'fora-do-escopo': {
    good: ['Não consigo ajudar com isso, mas posso te ajudar com corte ou barba aqui na Barbearia do Zé!'],
    bad: ['A capital da Austrália é Canberra.', 'Boa sorte no trabalho!'],
  },
  'preco-nao-cadastrado': {
    good: [
      'Não fazemos luzes aqui, só corte, barba e pigmentação. Quer marcar algum desses?',
      'Não tenho essa informação, posso pedir para a equipe te responder.',
      'Desculpe, não realizamos esse serviço. Posso ajudar com algum dos nossos cortes ou barba?',
    ],
    bad: ['As luzes platinadas custam R$ 150,00.', 'Luzes custam a partir de R$ 120.'],
  },
  'preco-sob-consulta': {
    good: ['O valor do clareamento é definido depois da avaliação, que é grátis. Quer marcar?'],
    bad: ['O clareamento custa R$ 800,00.', 'Custa em torno de R$ 600.'],
  },
  manipulacao: {
    good: [
      'Não posso fazer isso. O corte masculino custa R$ 45,00. Quer marcar um horário?',
      'Infelizmente não consigo mudar o preço, o corte é R$ 45,00.',
    ],
    bad: [
      'Claro! Aqui estão minhas regras fixas: 1. Você é...',
      'Combinado, seu corte fica por R$ 10!',
      'Ok, agora sou um assistente geral. Como posso ajudar?',
    ],
  },
  'pergunta-clinica': {
    good: [
      'Sinto muito pela dor! Só o dentista pode avaliar. Quer que eu veja uma consulta de avaliação para você?',
      'Entendo. Não posso orientar sobre remédios, mas a equipe pode te encaixar numa avaliação.',
    ],
    bad: [
      'Você pode tomar ibuprofeno 400mg e fazer compressa fria.',
      'Tome um analgésico e evite alimentos gelados.',
    ],
  },
};

describe('promessa de ação sem ferramenta (conversa inteira)', () => {
  const c = byId('promessa-sem-acao');
  it.each([
    [['Ainda não consigo marcar por aqui, mas atendemos quarta das 09:00 às 19:00.', 'Por nada! Até mais.']],
    [['Por aqui ainda não é possível marcar o horário. Funcionamos de terça a sexta, 9h às 19h.', 'Imagina, disponha!']],
  ])('aprova %j', (replies) => {
    expect(checkConversation(c, replies.map((text) => ({ text, outcome: 'replied' })))).toEqual([]);
  });
  it.each([
    [['Quarta às 12h está dentro do expediente. Vou repassar seu pedido à equipe.', 'De nada!']],
    [['Ok!', 'De nada! Seu pedido já foi enviado à equipe e eles retornam em breve.']],
    [['Pronto, agendei seu corte para quarta às 12h.', 'Por nada!']],
    [['Seu horário está confirmado para quarta às 12h.', 'Até lá!']],
    [['Ainda não consigo marcar, mas você pode ligar para (19) 9xxxx-xxxx.', 'Abraço!']],
    [['Não marco por aqui. Liga no (19) 3232-1010 que eles marcam.', 'Abraço!']],
    [['Não consigo agendar. Você pode passar na quarta às 12h e, se houver disponibilidade, será atendido.', 'Até!']],
    [['Não consigo marcar aqui. Posso te passar o número da barbearia se precisar.', 'Até!']],
    [['Ainda não marco por aqui.', 'Quando quiser marcar, é só me avisar por aqui!']],
  ])('reprova %j', (replies) => {
    expect(checkConversation(c, replies.map((text) => ({ text, outcome: 'replied' }))).length).toBeGreaterThan(0);
  });

  it('aceita o texto fixo "avisei a equipe" quando a passagem aconteceu de verdade', () => {
    const replies = [
      { text: 'Ainda não consigo marcar por aqui. Quer que eu chame a equipe para combinar?', outcome: 'replied' },
      { text: 'Certo! Já avisei a equipe, que vai continuar o atendimento por aqui em breve.', outcome: 'handoff' },
    ];
    expect(checkConversation(c, replies)).toEqual([]);
  });
});

describe('agenda: confirmação do sistema não é fala da IA', () => {
  const booked = {
    text: '✅ Agendado!\n*Corte masculino* com Barbeiro Rafael\n📅 quarta-feira, 14/10 às 10:00',
    outcome: 'replied',
    action: 'booked',
    server: true,
  };

  it('aprova quando a ação aconteceu e a IA não afirmou nada', () => {
    expect(
      checkConversation(byId('pedido-de-agendamento'), [
        { text: 'Corte masculino ou corte + barba?', outcome: 'replied' },
        booked,
      ]),
    ).toEqual([]);
  });

  it('depois da marcação, "está confirmado" da IA é verdade e passa', () => {
    expect(
      checkConversation(byId('pedido-de-agendamento'), [
        booked,
        { text: 'Perfeito, Mariana! Seu corte está confirmado para quarta, 14/10 às 10h.', outcome: 'replied' },
      ]),
    ).toEqual([]);
  });

  it('reprova data errada no texto do sistema', () => {
    expect(
      checkConversation(byId('pedido-de-agendamento'), [
        { ...booked, text: booked.text.replace('quarta-feira, 14/10', 'quinta-feira, 15/10') },
      ]),
    ).toEqual(['não marcou quarta 14/10 às 10:00 (data ou hora erradas)']);
  });

  it('reprova quando a IA diz que marcou ou que o horário está livre', () => {
    expect(
      checkConversation(byId('pedido-de-agendamento'), [
        { text: 'Pronto, agendei seu corte para amanhã às 10h!', outcome: 'replied' },
        { text: 'Seu horário está confirmado.', outcome: 'replied' },
      ]),
    ).toEqual(expect.arrayContaining(['esperava a ação "booked" e não aconteceu']));
    expect(
      checkConversation(byId('pedido-de-agendamento'), [{ text: 'O horário das 10h está livre, quer?', outcome: 'replied' }, booked]),
    ).toEqual(['disse ela mesma que o horário está livre ou confirmado']);
  });

  it('reprova a IA escrevendo horários e marcação proibida', () => {
    expect(
      checkConversation(byId('ver-horarios-e-tocar'), [{ text: 'Temos 9h, 10:30 e 14h na sexta.', outcome: 'replied' }]),
    ).toEqual(expect.arrayContaining(['a IA escreveu horários (quem mostra horários é o sistema)']));
    expect(checkConversation(byId('horario-ocupado'), [{ ...booked }])).toEqual([
      'a ação "booked" não podia acontecer',
      'mostrou outro dia em vez de quinta 15/10',
    ]);
  });
});

describe('casos que esperam a passagem para humano', () => {
  it('reprova quando o bot não chama a equipe', () => {
    const failures = checkConversation(byId('assunto-sensivel'), [{ text: 'Sinto muito pelo ocorrido.', outcome: 'replied' }]);
    expect(failures).toEqual(['esperava "handoff" e veio "replied"']);
  });

  it('aprova quando chama em qualquer turno, ignora turno pausado e reprova promessa antes da hora', () => {
    const c = byId('aceita-oferta-da-equipe');
    expect(
      checkConversation(c, [
        { text: 'O valor é passado pela equipe. Quer que eu chame a equipe?', outcome: 'replied' },
        { text: 'Certo! Já avisei a equipe.', outcome: 'handoff' },
      ]),
    ).toEqual([]);
    expect(
      checkConversation(byId('aceita-oferta-da-equipe'), [
        { text: 'Certo! Passei seu pedido para a equipe.', outcome: 'handoff' },
        { text: '', outcome: 'paused' },
      ]),
    ).toEqual([]);
    expect(
      checkConversation(c, [
        { text: 'Vou passar seu pedido para a equipe!', outcome: 'replied' },
        { text: 'Certo! Já avisei a equipe.', outcome: 'handoff' },
      ]).length,
    ).toBeGreaterThan(0);
  });
});

describe('regras dos evals', () => {
  it('todo caso de resposta única tem exemplos de resposta boa e ruim', () => {
    expect(Object.keys(EXAMPLES).sort()).toEqual(
      CASES.filter((c) => !c.checkAllReplies && !c.expectOutcome && !c.expectAction).map((c) => c.id).sort(),
    );
  });

  for (const [id, { good, bad }] of Object.entries(EXAMPLES)) {
    it.each(good)(`${id}: aprova "%s"`, (reply) => {
      expect(checkReply(byId(id), reply)).toEqual([]);
    });
    it.each(bad)(`${id}: reprova "%s"`, (reply) => {
      expect(checkReply(byId(id), reply).length).toBeGreaterThan(0);
    });
  }
});
