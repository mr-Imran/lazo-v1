import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { clerkClient } from '@clerk/express';
import type { AppRole } from '../auth/roles.decorator.js';

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export interface AdminUser {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
  role: AppRole | null;
  createdAt: string;
  lastSignInAt: string | null;
}

export interface AdminUserPage {
  users: AdminUser[];
  total: number;
  limit: number;
  offset: number;
}

interface ListOptions {
  limit?: string;
  offset?: string;
  search?: string;
}

/**
 * Reads the user list out of Clerk for the admin surface.
 *
 * Reads Clerk directly so the admin list is always current. Clerk owns users;
 * public.users is only a mirror (see UsersService) for joins and reporting.
 */
@Injectable()
export class AdminUsersService {
  async list({ limit, offset, search }: ListOptions): Promise<AdminUserPage> {
    const take = bounded(limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE, 'limit');
    const skip = bounded(offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');

    try {
      const page = await clerkClient.users.getUserList({
        limit: take,
        offset: skip,
        ...(search ? { query: search } : {}),
      });

      return {
        users: page.data.map(toAdminUser),
        total: page.totalCount,
        limit: take,
        offset: skip,
      };
    } catch (error) {
      throw new InternalServerErrorException(
        `Could not load users: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}

function toAdminUser(user: {
  id: string;
  primaryEmailAddressId: string | null;
  emailAddresses: { id: string; emailAddress: string }[];
  firstName: string | null;
  lastName: string | null;
  imageUrl: string;
  publicMetadata: Record<string, unknown>;
  privateMetadata: Record<string, unknown>;
  createdAt: number;
  lastSignInAt: number | null;
}): AdminUser {
  const primary =
    user.emailAddresses.find((address) => address.id === user.primaryEmailAddressId) ??
    user.emailAddresses[0];

  const role = user.privateMetadata?.['role'] ?? user.publicMetadata?.['role'];

  return {
    id: user.id,
    email: primary?.emailAddress ?? null,
    firstName: user.firstName,
    lastName: user.lastName,
    imageUrl: user.imageUrl,
    role: role === 'admin' ? 'admin' : null,
    createdAt: new Date(user.createdAt).toISOString(),
    lastSignInAt: user.lastSignInAt ? new Date(user.lastSignInAt).toISOString() : null,
  };
}

function bounded(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new BadRequestException(`${field} must be a whole number between ${min} and ${max}`);
  }

  return parsed;
}
