'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, useFieldArray, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

const stepSchema = z
  .object({
    day_offset: z
      .number({ invalid_type_error: 'Indica um número de dias.' })
      .int()
      .min(0, 'Mínimo 0 dias.')
      .max(90, 'Máximo 90 dias.'),
    channel: z.enum(['email', 'whatsapp']),
    subject: z.string().max(200).optional().or(z.literal('')),
    body: z
      .string()
      .min(1, 'O corpo do passo é obrigatório.')
      .max(10000, 'Máximo 10.000 caracteres.'),
  })
  .refine(
    (s) => s.channel !== 'email' || (s.subject && s.subject.trim().length > 0),
    {
      message: 'O assunto é obrigatório em passos de email.',
      path: ['subject'],
    }
  );

const formSchema = z.object({
  name: z
    .string()
    .min(2, 'O nome tem de ter pelo menos 2 caracteres.')
    .max(120, 'Máximo 120 caracteres.'),
  steps: z.array(stepSchema).min(1, 'Adiciona pelo menos um passo.'),
});

type FormValues = z.infer<typeof formSchema>;

interface SequenceCreateResponse {
  data?: { id?: string };
  error?: { code?: string; message?: string };
}

export interface NewSequenceFormProps {
  workspaceId: string;
}

export function NewSequenceForm({ workspaceId }: NewSequenceFormProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState<
    null | 'draft' | 'active'
  >(null);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
    watch,
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      steps: [
        {
          day_offset: 0,
          channel: 'email',
          subject: '',
          body: '',
        },
      ],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'steps',
  });

  const watchedSteps = watch('steps');

  async function submit(
    values: FormValues,
    status: 'draft' | 'active'
  ): Promise<void> {
    setSubmitting(status);
    setError(null);

    try {
      const res = await fetch('/api/sequences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          name: values.name,
          steps: values.steps,
          status,
        }),
      });

      const body = (await res
        .json()
        .catch(() => ({}))) as SequenceCreateResponse;

      if (!res.ok || !body.data?.id) {
        setError(
          body.error?.message ??
            'Não foi possível guardar a sequência. Tenta novamente.'
        );
        setSubmitting(null);
        return;
      }

      router.push(`/outreach/${body.data.id}`);
    } catch {
      setError('Erro de rede. Verifica a tua ligação e tenta novamente.');
      setSubmitting(null);
    }
  }

  const onSaveDraft: SubmitHandler<FormValues> = (values) =>
    submit(values, 'draft');
  const onSaveActive: SubmitHandler<FormValues> = (values) =>
    submit(values, 'active');

  return (
    <form className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Detalhes</CardTitle>
          <CardDescription>
            Dá um nome interno à sequência. Os contactos não vêem este nome.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Label htmlFor="name">Nome</Label>
          <Input
            id="name"
            placeholder="Ex: Outreach Q3 — Tech AO"
            {...register('name')}
          />
          {errors.name ? (
            <p className="text-xs text-destructive" role="alert">
              {errors.name.message}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Passos</h2>
            <p className="text-sm text-muted-foreground">
              Cada passo é enviado no dia indicado a contar da inscrição do
              contacto.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              append({
                day_offset:
                  (watchedSteps?.[watchedSteps.length - 1]?.day_offset ?? 0) +
                  3,
                channel: 'email',
                subject: '',
                body: '',
              })
            }
          >
            Adicionar passo
          </Button>
        </div>

        {errors.steps?.message ? (
          <p className="text-xs text-destructive" role="alert">
            {errors.steps.message}
          </p>
        ) : null}

        {fields.map((field, index) => {
          const stepErr = errors.steps?.[index];
          const channelValue = watchedSteps?.[index]?.channel ?? 'email';
          const isEmail = channelValue === 'email';

          return (
            <Card key={field.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">
                    Passo {index + 1}
                  </CardTitle>
                  {fields.length > 1 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => remove(index)}
                    >
                      Remover
                    </Button>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`step-${index}-day`}>Dia (offset)</Label>
                  <Input
                    id={`step-${index}-day`}
                    type="number"
                    min={0}
                    max={90}
                    {...register(`steps.${index}.day_offset`, {
                      valueAsNumber: true,
                    })}
                  />
                  {stepErr?.day_offset ? (
                    <p className="text-xs text-destructive" role="alert">
                      {stepErr.day_offset.message}
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor={`step-${index}-channel`}>Canal</Label>
                  <Select
                    id={`step-${index}-channel`}
                    {...register(`steps.${index}.channel`)}
                  >
                    <option value="email">Email</option>
                    <option value="whatsapp" disabled>
                      WhatsApp (em breve — M3.4)
                    </option>
                  </Select>
                  {stepErr?.channel ? (
                    <p className="text-xs text-destructive" role="alert">
                      {stepErr.channel.message}
                    </p>
                  ) : null}
                </div>

                {isEmail ? (
                  <div className="flex flex-col gap-2 md:col-span-2">
                    <Label htmlFor={`step-${index}-subject`}>Assunto</Label>
                    <Input
                      id={`step-${index}-subject`}
                      placeholder="Ex: Sobre o crescimento da {{company}}"
                      {...register(`steps.${index}.subject`)}
                    />
                    {stepErr?.subject ? (
                      <p className="text-xs text-destructive" role="alert">
                        {stepErr.subject.message}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                <div className="flex flex-col gap-2 md:col-span-2">
                  <Label htmlFor={`step-${index}-body`}>Mensagem</Label>
                  <Textarea
                    id={`step-${index}-body`}
                    rows={6}
                    placeholder="Olá {{first_name}}, ..."
                    {...register(`steps.${index}.body`)}
                  />
                  {stepErr?.body ? (
                    <p className="text-xs text-destructive" role="alert">
                      {stepErr.body.message}
                    </p>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          onClick={handleSubmit(onSaveDraft)}
          disabled={submitting !== null}
        >
          {submitting === 'draft' ? <Spinner /> : null}
          {submitting === 'draft' ? 'A guardar...' : 'Guardar como rascunho'}
        </Button>
        <Button
          onClick={handleSubmit(onSaveActive)}
          disabled={submitting !== null}
        >
          {submitting === 'active' ? <Spinner /> : null}
          {submitting === 'active' ? 'A activar...' : 'Guardar e activar'}
        </Button>
      </div>
    </form>
  );
}
