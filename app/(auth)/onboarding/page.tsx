'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';

const SLUG_REGEX = /^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$/;

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
}

const onboardingSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'O nome deve ter pelo menos 2 caracteres')
    .max(80, 'Máximo 80 caracteres'),
  slug: z
    .string()
    .min(3, 'O slug deve ter pelo menos 3 caracteres')
    .max(40, 'Máximo 40 caracteres')
    .regex(
      SLUG_REGEX,
      'Apenas letras minúsculas, números e hífens. Não pode começar nem terminar com hífen.'
    ),
});

type OnboardingFormValues = z.infer<typeof onboardingSchema>;

type ApiError = {
  error?: { code?: string; message?: string };
};

export default function OnboardingPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    setError,
    formState: { errors },
  } = useForm<OnboardingFormValues>({
    resolver: zodResolver(onboardingSchema),
    defaultValues: { name: '', slug: '' },
    mode: 'onChange',
  });

  const nameValue = watch('name');

  useEffect(() => {
    if (slugManuallyEdited) return;
    const generated = slugify(nameValue ?? '');
    setValue('slug', generated, { shouldValidate: generated.length > 0 });
  }, [nameValue, slugManuallyEdited, setValue]);

  async function onSubmit(values: OnboardingFormValues) {
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: values.name, slug: values.slug }),
      });

      if (res.ok) {
        router.push('/search');
        router.refresh();
        return;
      }

      const payload = (await res.json().catch(() => ({}))) as ApiError;
      const code = payload?.error?.code;

      if (res.status === 409 || code === 'SLUG_TAKEN') {
        setError('slug', {
          type: 'manual',
          message: 'Este slug já existe. Escolhe outro.',
        });
      } else if (res.status === 400 || code === 'INVALID_INPUT') {
        setFormError('Nome ou slug inválidos. Revê os campos.');
      } else {
        setFormError(
          payload?.error?.message ??
            'Não foi possível criar o workspace. Tenta novamente.'
        );
      }
    } catch {
      setFormError('Erro de rede. Verifica a tua ligação e tenta novamente.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cria o teu workspace</CardTitle>
        <CardDescription>
          O workspace agrupa a tua equipa, contactos e sequências. Recebes 50
          créditos de bónus para começar a explorar.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {formError ? (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="name">Nome do workspace</Label>
            <Input
              id="name"
              type="text"
              placeholder="Ex.: Acme Angola"
              autoFocus
              disabled={submitting}
              {...register('name')}
            />
            {errors.name ? (
              <p className="text-xs text-destructive">{errors.name.message}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="slug">Slug</Label>
            <div className="flex items-center rounded-md border border-input bg-background pl-3 text-sm">
              <span className="text-muted-foreground">angoconnect.app/</span>
              <Input
                id="slug"
                type="text"
                placeholder="acme-angola"
                disabled={submitting}
                className="border-0 px-1 focus-visible:ring-0 focus-visible:ring-offset-0"
                {...register('slug', {
                  onChange: () => setSlugManuallyEdited(true),
                })}
              />
            </div>
            {errors.slug ? (
              <p className="text-xs text-destructive">{errors.slug.message}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                3-40 caracteres. Letras minúsculas, números e hífens.
              </p>
            )}
          </div>

          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? <Spinner /> : null}
            {submitting ? 'A criar...' : 'Criar workspace'}
          </Button>
        </form>
      </CardContent>
      <CardFooter className="justify-center">
        <p className="text-xs text-muted-foreground">
          Já podes convidar a tua equipa após a criação.
        </p>
      </CardFooter>
    </Card>
  );
}
