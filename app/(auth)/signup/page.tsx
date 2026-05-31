'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';

const signupSchema = z
  .object({
    fullName: z.string().trim().min(2, 'O nome deve ter pelo menos 2 caracteres'),
    email: z.string().email('Email inválido'),
    password: z.string().min(8, 'A password deve ter pelo menos 8 caracteres'),
    confirmPassword: z.string().min(8, 'Confirma a password'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ['confirmPassword'],
    message: 'As passwords não coincidem',
  });

type SignupFormValues = z.infer<typeof signupSchema>;

export default function SignupPage() {
  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmationSent, setConfirmationSent] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignupFormValues>({
    resolver: zodResolver(signupSchema),
    defaultValues: {
      fullName: '',
      email: '',
      password: '',
      confirmPassword: '',
    },
  });

  async function onSubmit(values: SignupFormValues) {
    setFormError(null);
    setSubmitting(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signUp({
        email: values.email,
        password: values.password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
          data: { full_name: values.fullName },
        },
      });
      if (error) {
        setFormError(error.message);
        setSubmitting(false);
        return;
      }
      setConfirmationSent(values.email);
    } catch {
      setFormError('Ocorreu um erro inesperado. Tenta novamente.');
    } finally {
      setSubmitting(false);
    }
  }

  async function onGoogleSignUp() {
    setFormError(null);
    setGoogleLoading(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) {
        setFormError(error.message);
        setGoogleLoading(false);
      }
    } catch {
      setFormError('Não foi possível continuar com Google.');
      setGoogleLoading(false);
    }
  }

  if (confirmationSent) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Confirma o teu email</CardTitle>
          <CardDescription>
            Enviámos uma mensagem para <strong>{confirmationSent}</strong>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertTitle>Quase lá</AlertTitle>
            <AlertDescription>
              Abre o teu email e clica no link de confirmação para activar a
              conta. Depois podes entrar com as credenciais que escolheste.
            </AlertDescription>
          </Alert>
          <p className="text-sm text-muted-foreground">
            Não recebeste? Verifica a pasta de spam ou tenta novamente em alguns
            minutos.
          </p>
        </CardContent>
        <CardFooter className="justify-center">
          <Link
            href="/login"
            className="text-sm font-medium text-foreground underline-offset-4 hover:underline"
          >
            Voltar para entrar
          </Link>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Criar conta</CardTitle>
        <CardDescription>
          Começa a prospectar empresas em Angola. Recebes 50 créditos de
          boas-vindas.
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
            <Label htmlFor="fullName">Nome completo</Label>
            <Input
              id="fullName"
              type="text"
              autoComplete="name"
              placeholder="João Manuel"
              disabled={submitting}
              {...register('fullName')}
            />
            {errors.fullName ? (
              <p className="text-xs text-destructive">
                {errors.fullName.message}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="nome@empresa.ao"
              disabled={submitting}
              {...register('email')}
            />
            {errors.email ? (
              <p className="text-xs text-destructive">{errors.email.message}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              placeholder="Mínimo 8 caracteres"
              disabled={submitting}
              {...register('password')}
            />
            {errors.password ? (
              <p className="text-xs text-destructive">
                {errors.password.message}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirmPassword">Confirmar password</Label>
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              placeholder="Repete a password"
              disabled={submitting}
              {...register('confirmPassword')}
            />
            {errors.confirmPassword ? (
              <p className="text-xs text-destructive">
                {errors.confirmPassword.message}
              </p>
            ) : null}
          </div>

          <Button
            type="submit"
            className="w-full"
            disabled={submitting || googleLoading}
          >
            {submitting ? <Spinner /> : null}
            {submitting ? 'A criar conta...' : 'Criar conta'}
          </Button>
        </form>

        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-card px-2 text-muted-foreground">
              ou continua com
            </span>
          </div>
        </div>

        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={onGoogleSignUp}
          disabled={submitting || googleLoading}
        >
          {googleLoading ? <Spinner /> : null}
          {googleLoading ? 'A redireccionar...' : 'Continuar com Google'}
        </Button>
      </CardContent>
      <CardFooter className="justify-center">
        <p className="text-sm text-muted-foreground">
          Já tens conta?{' '}
          <Link
            href="/login"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            Entrar
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
