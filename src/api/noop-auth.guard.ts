import { Injectable, type CanActivate } from '@nestjs/common';

/**
 * PONTO DE EXTENSÃO de autenticação (decisão documentada no ARCHITECTURE.md).
 * Hoje libera tudo. O desenho previsto: validar JWT (OIDC) emitido por um IdP
 * externo (Keycloak/Zitadel) e exigir que o `providerId` do token seja o mesmo
 * do corpo da requisição. Health e /metrics ficam fora do guard.
 */
@Injectable()
export class NoopAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
